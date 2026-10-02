import type { CommandAction, OperationsContext, RunCommand } from "./types";

export interface WorkspaceProps {
  context: OperationsContext;
  refreshKey: number;
  runCommand: RunCommand;
  openAction: (action: CommandAction) => void;
  onNotice: (message: string) => void;
  onRefresh: () => void;
}

