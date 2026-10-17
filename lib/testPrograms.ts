import db = require("./db");
import programs = require("./programs");

interface ProgramFixture {
  id: string;
  name: string;
  channels?: string[];
  helpChannel?: string | null;
  organizerChannel?: string | null;
  lifecycle?: "draft" | "testing" | "approved" | "active" | "paused" | "archived";
  [key: string]: unknown;
}

function clear(): void {
  for (const program of programs.all()) {
    for (const claim of db.listProgramChannels(program.id))
      db.releaseProgramChannel({ workspaceId: claim.workspace_id, channelId: claim.channel_id, programId: program.id });
    db.deleteProgram(program.id);
  }
  for (const table of ["program_docs", "program_eval_cases", "program_eval_runs"])
    db.handle().query(`DELETE FROM ${table}`).run();
}

function set(list: ProgramFixture[]): void {
  clear();
  for (const program of list) {
    db.saveProgram({ ...program, lifecycle: program.lifecycle || "active" });
    const channels = new Set([
      ...(program.channels || []),
      ...(program.helpChannel ? [program.helpChannel] : []),
      ...(program.organizerChannel ? [program.organizerChannel] : []),
    ]);
    for (const channelId of channels)
      db.claimProgramChannel({
        programId: program.id,
        channelId,
        kind:
          channelId === program.helpChannel
            ? "help"
            : channelId === program.organizerChannel
              ? "organizer"
              : "discussion",
      });
  }
  programs.invalidate();
}

function snapshot(): ProgramFixture[] {
  return JSON.parse(JSON.stringify(programs.all()));
}
function restore(saved: ProgramFixture[]): void {
  set(saved);
}

export = { set, clear, snapshot, restore };
