// A hírkereső job indítása az ütemezőn át: az ütemező által indított folyamatban HTTP-n (SCHED_* környezet), egyébként
// (Telegram-parancs, asszisztens, terminál) az ütemező CLI-jén át (SCHEDULER_ROOT, alapból a testvér ..\scheduler),
// lásd ..\CONVENTIONS.md „Telegram és ütemezés".
import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { runSchedulerJob, type RunJobIo } from "./tg-app";

const res = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;
const cliError = (stderr: string, code = 1) => Object.assign(new Error("Command failed"), { code, stdout: "", stderr });
const io = (over: Partial<RunJobIo> = {}): RunJobIo => ({
  fetch: vi.fn(),
  execFile: vi.fn(),
  ...over,
});

const SCHED_ENV = { SCHED_URL: "http://127.0.0.1:47900", SCHED_APP: "portfolio", SCHED_KEY: "titkos" };
const ROOT = resolve("C:/work/scheduler");

describe("runSchedulerJob: az ütemező által indított folyamatban (HTTP)", () => {
  it("202 → started, az app saját kulcsával", async () => {
    const fetch = vi.fn().mockResolvedValue(res(202));
    const execFile = vi.fn();
    await expect(runSchedulerJob("news-morning", SCHED_ENV, io({ fetch, execFile }))).resolves.toBe("started");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47900/v1/apps/portfolio/jobs/news-morning/run",
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer titkos" } }),
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("409 → running", async () => {
    await expect(runSchedulerJob("news-evening", SCHED_ENV, io({ fetch: vi.fn().mockResolvedValue(res(409)) }))).resolves.toBe("running");
  });

  it("más hiba → dob, a HTTP-állapottal; nem esik át a CLI-re (a kulcs megvolt, az ütemező válaszolt)", async () => {
    const execFile = vi.fn();
    await expect(runSchedulerJob("news-evening", { ...SCHED_ENV, SCHEDULER_ROOT: ROOT }, io({ fetch: vi.fn().mockResolvedValue(res(500)), execFile }))).rejects.toThrow(/HTTP 500/);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("runSchedulerJob: máshol az ütemező CLI-jén át (SCHEDULER_ROOT)", () => {
  it("a CLI run-job parancsát hívja a portfolio app-azonosítójával; 0-s kilépés → started", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "portfolio/news-evening elindítva.\n", stderr: "" });
    await expect(runSchedulerJob("news-evening", { SCHEDULER_ROOT: ROOT }, io({ execFile }))).resolves.toBe("started");
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([resolve(ROOT, "src", "cli.ts"), "run-job", "--app", "portfolio", "--job", "news-evening"]);
  });

  it("alapból a testvér ..\\scheduler mappát használja", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await runSchedulerJob("news-evening", {}, io({ execFile }));
    expect(execFile.mock.calls[0][1][0]).toBe(resolve(process.cwd(), "..", "scheduler", "src", "cli.ts"));
  });

  it("a SCHED_APP felülírja az app-azonosítót (ha az ütemező megadja)", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    await runSchedulerJob("news-morning", { SCHEDULER_ROOT: ROOT, SCHED_APP: "masik" }, io({ execFile }));
    expect(execFile.mock.calls[0][1]).toContain("masik");
  });

  it("a CLI „409: a job épp fut” hibája → running", async () => {
    const execFile = vi.fn().mockRejectedValue(cliError("409: a job épp fut"));
    await expect(runSchedulerJob("news-morning", { SCHEDULER_ROOT: ROOT }, io({ execFile }))).resolves.toBe("running");
  });

  it("a CLI más hibája → dob, a CLI üzenetével (pl. az ütemező nem fut)", async () => {
    const execFile = vi.fn().mockRejectedValue(cliError("Az ütemező nem fut (vagy más porton van)."));
    await expect(runSchedulerJob("news-morning", { SCHEDULER_ROOT: ROOT }, io({ execFile }))).rejects.toThrow(/Az ütemező nem fut/);
  });

  it("ha a CLI nem indítható (nincs fájl, időtúllépés), a hiba érthető", async () => {
    const execFile = vi.fn().mockRejectedValue(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(runSchedulerJob("news-morning", { SCHEDULER_ROOT: ROOT }, io({ execFile }))).rejects.toThrow(/ütemező CLI|ENOENT/);
  });

  it("hiányos környezetnél (pl. csak az URL) is a CLI-re esik vissza, nem dob kulcshiányt", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "" });
    const i = io({ execFile });
    await expect(runSchedulerJob("news-morning", { SCHED_URL: "http://x", SCHEDULER_ROOT: ROOT }, i)).resolves.toBe("started");
    expect(i.fetch).not.toHaveBeenCalled();
  });
});
