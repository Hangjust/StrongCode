$ErrorActionPreference = "Stop"

$source = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace StrongCode
{
    public static class WindowsJobHost
    {
        private const int MaximumInputBytes = 1024 * 1024;
        private const uint JobObjectBasicProcessIdList = 3;
        private const uint JobObjectExtendedLimitInformation = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const uint HandleFlagInherit = 0x00000001;
        private const int ErrorMoreData = 234;
        private static IntPtr retainedJob = IntPtr.Zero;
        private static long hostProcessId;

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private sealed class LaunchSpecification
        {
            public string Executable;
            public string[] Arguments;
            public string WorkingDirectory;
            public Dictionary<string, string> Environment;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength, IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetHandleInformation(IntPtr handle, out uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static int Run(Stream standardInput)
        {
            LaunchSpecification specification = Parse(ReadBoundedInput(standardInput));
            ConfigureJob();
            int exitCode = RunTarget(specification);
            while (!OnlyHostRemains()) Thread.Sleep(10);
            return exitCode;
        }

        private static byte[] ReadBoundedInput(Stream input)
        {
            using (MemoryStream output = new MemoryStream())
            {
                byte[] buffer = new byte[8192];
                while (true)
                {
                    int count = input.Read(buffer, 0, buffer.Length);
                    if (count == 0) return output.ToArray();
                    if (output.Length + count > MaximumInputBytes) throw new InvalidDataException("Launch specification exceeds the byte limit");
                    output.Write(buffer, 0, count);
                }
            }
        }

        private static LaunchSpecification Parse(byte[] bytes)
        {
            string json = new UTF8Encoding(false, true).GetString(bytes);
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = MaximumInputBytes;
            serializer.RecursionLimit = 8;
            IDictionary<string, object> root = serializer.DeserializeObject(json) as IDictionary<string, object>;
            if (root == null || root.Count != 4 || !root.ContainsKey("executable") || !root.ContainsKey("args") || !root.ContainsKey("cwd") || !root.ContainsKey("env"))
                throw new InvalidDataException("Launch specification must contain only executable, args, cwd, and env");

            string executable = RequireSafeAbsolutePath(root["executable"], "executable");
            string workingDirectory = RequireSafeAbsolutePath(root["cwd"], "cwd");
            object[] rawArguments = root["args"] as object[];
            IDictionary<string, object> rawEnvironment = root["env"] as IDictionary<string, object>;
            if (rawArguments == null || rawArguments.Length > 4096) throw new InvalidDataException("args must be a bounded array");
            if (rawEnvironment == null || rawEnvironment.Count > 4096) throw new InvalidDataException("env must be a bounded object");

            string[] arguments = new string[rawArguments.Length];
            for (int index = 0; index < rawArguments.Length; index++) arguments[index] = RequireString(rawArguments[index], "args", true);
            Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, object> entry in rawEnvironment)
            {
                if (entry.Key.Length == 0 || entry.Key.IndexOf('\0') >= 0 || entry.Key.IndexOf('=') >= 0 || environment.ContainsKey(entry.Key))
                    throw new InvalidDataException("env contains an invalid or duplicate key");
                environment.Add(entry.Key, RequireString(entry.Value, "env", true));
            }
            return new LaunchSpecification { Executable = executable, Arguments = arguments, WorkingDirectory = workingDirectory, Environment = environment };
        }

        private static string RequireString(object value, string field, bool allowEmpty)
        {
            string text = value as string;
            if (text == null || text.IndexOf('\0') >= 0 || (!allowEmpty && text.Length == 0)) throw new InvalidDataException(field + " contains an invalid string");
            return text;
        }

        private static string RequireSafeAbsolutePath(object value, string field)
        {
            string text = RequireString(value, field, false);
            foreach (char character in text)
                if (character < 32 || character == 127) throw new InvalidDataException(field + " contains control characters");
            string normalized = text.Replace('/', '\\');
            if (normalized.StartsWith(@"\\.\", StringComparison.Ordinal)
                || normalized.StartsWith(@"\\?\", StringComparison.Ordinal)
                || normalized.StartsWith(@"\??\", StringComparison.Ordinal)
                || normalized.StartsWith(@"\\??\", StringComparison.Ordinal))
                throw new InvalidDataException(field + " uses a device path");
            bool driveAbsolute = normalized.Length >= 3
                && Char.IsLetter(normalized[0])
                && normalized[1] == ':'
                && normalized[2] == '\\';
            bool uncAbsolute = normalized.StartsWith(@"\\", StringComparison.Ordinal) && normalized.Length > 2;
            if (!driveAbsolute && !uncAbsolute) throw new InvalidDataException(field + " must be an absolute path");

            string root = Path.GetPathRoot(normalized);
            if (String.IsNullOrEmpty(root)) throw new InvalidDataException(field + " must have an absolute root");
            string remainder = normalized.Substring(root.Length);
            if (remainder.IndexOf(':') >= 0) throw new InvalidDataException(field + " contains an alternate data stream");
            foreach (string segment in remainder.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (segment == "." || segment == ".." || segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal))
                    throw new InvalidDataException(field + " contains an unsafe segment");
                string device = segment.Split('.')[0].ToUpperInvariant();
                if (device == "CON" || device == "PRN" || device == "AUX" || device == "NUL"
                    || (device.Length == 4 && (device.StartsWith("COM", StringComparison.Ordinal) || device.StartsWith("LPT", StringComparison.Ordinal))
                        && device[3] >= '1' && device[3] <= '9'))
                    throw new InvalidDataException(field + " contains a device segment");
            }
            return normalized;
        }

        private static void ConfigureJob()
        {
            IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw LastError("CreateJobObjectW");
            try
            {
                if (!SetHandleInformation(job, HandleFlagInherit, 0)) throw LastError("SetHandleInformation");
                uint handleFlags;
                if (!GetHandleInformation(job, out handleFlags)) throw LastError("GetHandleInformation");
                if ((handleFlags & HandleFlagInherit) != 0) throw new InvalidOperationException("Job handle remained inheritable");

                ExtendedLimitInformation limits = new ExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                SetLimits(job, limits);
                ExtendedLimitInformation observed = QueryLimits(job);
                if ((observed.BasicLimitInformation.LimitFlags & JobObjectLimitKillOnJobClose) == 0)
                    throw new InvalidOperationException("Job kill-on-close limit was not retained");
                using (Process current = Process.GetCurrentProcess())
                {
                    if (!AssignProcessToJobObject(job, current.Handle)) throw LastError("AssignProcessToJobObject");
                    retainedJob = job;
                    hostProcessId = current.Id;
                    job = IntPtr.Zero;
                    long[] members = QueryProcessIds(retainedJob);
                    if (members.Length != 1 || members[0] != current.Id) throw new InvalidOperationException("Job host assignment could not be confirmed");
                }
            }
            finally
            {
                if (job != IntPtr.Zero && !CloseHandle(job)) throw LastError("CloseHandle");
            }
        }

        private static void SetLimits(IntPtr job, ExtendedLimitInformation limits)
        {
            int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)) throw LastError("SetInformationJobObject");
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static ExtendedLimitInformation QueryLimits(IntPtr job)
        {
            int size = Marshal.SizeOf(typeof(ExtendedLimitInformation));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size, IntPtr.Zero)) throw LastError("QueryInformationJobObject");
                return (ExtendedLimitInformation)Marshal.PtrToStructure(buffer, typeof(ExtendedLimitInformation));
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static int RunTarget(LaunchSpecification specification)
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = specification.Executable;
            start.Arguments = JoinArguments(specification.Arguments);
            start.WorkingDirectory = specification.WorkingDirectory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.EnvironmentVariables.Clear();
            foreach (KeyValuePair<string, string> entry in specification.Environment) start.EnvironmentVariables.Add(entry.Key, entry.Value);
            using (Process target = Process.Start(start))
            {
                if (target == null) throw new InvalidOperationException("Target process did not start");
                target.StandardInput.Close();
                target.WaitForExit();
                return target.ExitCode;
            }
        }

        private static string JoinArguments(string[] arguments)
        {
            StringBuilder commandLine = new StringBuilder();
            for (int index = 0; index < arguments.Length; index++)
            {
                if (index > 0) commandLine.Append(' ');
                commandLine.Append(QuoteArgument(arguments[index]));
            }
            return commandLine.ToString();
        }

        private static string QuoteArgument(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
            StringBuilder quoted = new StringBuilder().Append('"');
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\') { backslashes++; continue; }
                if (character == '"') quoted.Append('\\', backslashes * 2 + 1).Append(character);
                else quoted.Append('\\', backslashes).Append(character);
                backslashes = 0;
            }
            return quoted.Append('\\', backslashes * 2).Append('"').ToString();
        }

        private static bool OnlyHostRemains()
        {
            long[] members = QueryProcessIds(retainedJob);
            return members.Length == 1 && members[0] == hostProcessId;
        }

        private static long[] QueryProcessIds(IntPtr job)
        {
            int capacity = 16;
            while (true)
            {
                int size = 8 + capacity * IntPtr.Size;
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    if (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)size, IntPtr.Zero))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error != ErrorMoreData) throw new Win32Exception(error, "QueryInformationJobObject failed");
                        capacity = Math.Max(capacity * 2, Marshal.ReadInt32(buffer));
                        continue;
                    }
                    int count = Marshal.ReadInt32(buffer, 4);
                    long[] identifiers = new long[count];
                    for (int index = 0; index < count; index++)
                        identifiers[index] = IntPtr.Size == 8 ? Marshal.ReadInt64(buffer, 8 + index * IntPtr.Size) : Marshal.ReadInt32(buffer, 8 + index * IntPtr.Size);
                    return identifiers;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }

        private static Win32Exception LastError(string operation)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
        }
    }
}
'@

try {
    $runtimeDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $webExtensions = [IO.Path]::GetFullPath([IO.Path]::Combine($runtimeDirectory, "System.Web.Extensions.dll"))
    if (![IO.Path]::IsPathRooted($webExtensions) -or ![IO.File]::Exists($webExtensions)) {
        throw "The pinned System.Web.Extensions.dll runtime assembly is unavailable"
    }
    Add-Type -TypeDefinition $source -ReferencedAssemblies $webExtensions
    $exitCode = [StrongCode.WindowsJobHost]::Run([Console]::OpenStandardInput())
    exit $exitCode
} catch {
    [Console]::Error.WriteLine("StrongCode Windows Job host failed: " + $_.Exception.Message)
    exit 254
}
