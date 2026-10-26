// Set in the environment of a report-polish fork. The fork carries the
// writer's whole conversation, protocol instructions included, so the CLI
// refuses `report submit` under this mark to keep a polish from recursing.
export const REPORT_POLISH_FORK_ENV = "WORQLOAD_REPORT_POLISH_FORK";
