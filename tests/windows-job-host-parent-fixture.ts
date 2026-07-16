import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  powerShellPath,
  trackProcess,
  windowsJobHostAsset
} from "./windows-job-host-process-fixture";

const JOB_ASSIGNMENT_ANCHOR = `                using (Process current = Process.GetCurrentProcess())
                {
                    if (!AssignProcessToJobObject(job, current.Handle)) throw LastError("AssignProcessToJobObject");`;
const TEST_UI_RESTRICTION_SETUP = `                IntPtr testUiRestrictions = Marshal.AllocHGlobal(sizeof(uint));
                try
                {
                    const uint JobObjectBasicUiRestrictions = 4;
                    const uint JobObjectUiLimitHandles = 0x00000001;
                    Marshal.WriteInt32(testUiRestrictions, (int)JobObjectUiLimitHandles);
                    if (!SetInformationJobObject(job, JobObjectBasicUiRestrictions, testUiRestrictions, sizeof(uint)))
                        throw LastError("SetInformationJobObject test UI restrictions");
                }
                finally { Marshal.FreeHGlobal(testUiRestrictions); }
`;

export async function spawnHostInParentJob(
  root: string,
  payload: Buffer,
  hostAsset: string
): Promise<ChildProcess> {
  const runner = path.join(root, "ordinary-parent.ps1");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("SystemRoot is required for parent Job tests");
  await writeFile(runner, String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public static class RestrictiveJobRunner
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicUiRestrictions { public uint UIRestrictionsClass; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Run(string powershell, string hostScript, string workingDirectory, string systemRoot, string temporaryDirectory, string payload)
    {
        IntPtr rootJob = CreateJobObjectW(IntPtr.Zero, null);
        if (rootJob == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create root Job failed");
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(rootJob);
            throw new Win32Exception(error, "Create parent Job failed");
        }
        try
        {
            BasicUiRestrictions rootRestrictions = new BasicUiRestrictions { UIRestrictionsClass = 0x1 };
            int rootSize = Marshal.SizeOf(typeof(BasicUiRestrictions));
            IntPtr rootBuffer = Marshal.AllocHGlobal(rootSize);
            try
            {
                Marshal.StructureToPtr(rootRestrictions, rootBuffer, false);
                if (!SetInformationJobObject(rootJob, 4, rootBuffer, (uint)rootSize))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Set root Job UI restrictions failed");
            }
            finally { Marshal.FreeHGlobal(rootBuffer); }

            using (Process current = Process.GetCurrentProcess())
            {
                if (!AssignProcessToJobObject(rootJob, current.Handle))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Root AssignProcessToJobObject failed");
                if (!AssignProcessToJobObject(job, current.Handle))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Parent AssignProcessToJobObject failed");
            }

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = powershell;
            start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + hostScript.Replace("\"", "\\\"") + "\"";
            start.WorkingDirectory = workingDirectory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables.Clear();
            start.EnvironmentVariables.Add("SystemRoot", systemRoot);
            start.EnvironmentVariables.Add("TEMP", temporaryDirectory);
            start.EnvironmentVariables.Add("TMP", temporaryDirectory);
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("Host process did not start");
                bool childInParent;
                if (!IsProcessInJob(child.Handle, job, out childInParent))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "IsProcessInJob failed");
                if (!childInParent) throw new InvalidOperationException("Host did not inherit the ordinary parent Job");
                bool childInRoot;
                if (!IsProcessInJob(child.Handle, rootJob, out childInRoot))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Root IsProcessInJob failed");
                if (!childInRoot) throw new InvalidOperationException("Host did not inherit the test root Job");
                child.StandardInput.Write(payload);
                child.StandardInput.Close();
                if (!child.WaitForExit(5000))
                {
                    child.Kill();
                    return 253;
                }
                Console.Out.Write(child.StandardOutput.ReadToEnd());
                Console.Error.Write(child.StandardError.ReadToEnd());
                return child.ExitCode;
            }
        }
        finally
        {
            CloseHandle(job);
            CloseHandle(rootJob);
        }
    }
}
'@
Add-Type -TypeDefinition $source
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[5]))
exit [RestrictiveJobRunner]::Run($args[0], $args[1], $args[2], $args[3], $args[4], $payload)
`, "utf8");
  const child = spawn(powerShellPath(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", runner, powerShellPath(), hostAsset, path.join(systemRoot, "System32"), systemRoot, root,
    payload.toString("base64")
  ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  return trackProcess(child);
}

export async function writeAssignmentFailureHost(root: string): Promise<string> {
  const source = await readFile(windowsJobHostAsset(), "utf8");
  const firstAnchor = source.indexOf(JOB_ASSIGNMENT_ANCHOR);
  const secondAnchor = firstAnchor < 0
    ? -1
    : source.indexOf(JOB_ASSIGNMENT_ANCHOR, firstAnchor + JOB_ASSIGNMENT_ANCHOR.length);
  if (firstAnchor < 0 || secondAnchor >= 0) {
    throw new TypeError("Production Windows Job host assignment anchor must occur exactly once");
  }
  const variant = `${source.slice(0, firstAnchor)}${TEST_UI_RESTRICTION_SETUP}${source.slice(firstAnchor)}`;
  const variantPath = path.join(root, "windows-job-host-assignment-failure.ps1");
  await writeFile(variantPath, variant, "utf8");
  return variantPath;
}
