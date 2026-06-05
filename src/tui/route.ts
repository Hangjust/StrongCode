export type TuiRouteName = "home" | "session" | "sessions" | "models" | "settings" | "diff" | "approval" | "picker" | "editorPaste";

export interface TuiRoute {
  name: TuiRouteName;
  title: string;
  params?: Record<string, string>;
}

export class TuiRouter {
  private currentRoute: TuiRoute = { name: "home", title: "Home" };

  current(): TuiRoute {
    return this.currentRoute;
  }

  go(name: TuiRouteName, params?: Record<string, string>): TuiRoute {
    const title = name[0].toUpperCase() + name.slice(1);
    this.currentRoute = { name, title, params };
    return this.currentRoute;
  }
}

export interface TuiScreenDescriptor {
  route: TuiRouteName;
  title: string;
  description: string;
}

export function screenForRoute(route: TuiRouteName): TuiScreenDescriptor {
  const screens: Record<TuiRouteName, TuiScreenDescriptor> = {
    home: { route: "home", title: "Home", description: "Home prompt and status shell" },
    session: { route: "session", title: "Session", description: "Active chat transcript and prompt" },
    sessions: { route: "sessions", title: "Sessions", description: "Saved session picker" },
    models: { route: "models", title: "Models", description: "Model/provider picker" },
    settings: { route: "settings", title: "Settings", description: "TUI settings" },
    diff: { route: "diff", title: "Diff", description: "File change review surface" },
    approval: { route: "approval", title: "Approval", description: "Tool approval request surface" },
    picker: { route: "picker", title: "Picker", description: "Generic selectable list surface" },
    editorPaste: { route: "editorPaste", title: "Editor Paste", description: "Large paste and external editor surface" }
  };
  return screens[route];
}
