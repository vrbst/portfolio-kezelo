// A hírkereső job indítása a tg-hubon át: a hub által indított folyamatban HTTP-n (TG_HUB_* környezet), kézi futásnál
// (pl. az asszisztensből vagy a terminálból) a hub CLI-jén át (TG_HUB_ROOT), lásd ..\CONVENTIONS.md „Telegram és ütemezés".
import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { runHubJob, type RunJobIo } from "./tg-app";

const res = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;
const cliError = (stderr: string, code = 1) => Object.assign(new Error("Command failed"), { code, stdout: "", stderr });
const io = (over: Partial<RunJobIo> = {}): RunJobIo => ({
  fetch: vi.fn(),
  execFile: vi.fn(),
  ...over,
});

const HUB_ENV = { TG_HUB_URL: "http://127.0.0.1:47800", TG_HUB_APP: "portfolio", TG_HUB_KEY: "titkos" };
const ROOT = resolve("C:/work/tg-hub");

describe("runHubJob: a hub által indított folyamatban (HTTP)", () => {
  it("202 → started, a hub saját kulcsával", async () => {
    const fetch = vi.fn().mockResolvedValue(res(202));
    const execFile = vi.fn();
    await expect(runHubJob("news-morning", HUB_ENV, io({ fetch, execFile }))).resolves.toBe("started");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47800/v1/apps/portfolio/jobs/news-morning/run",
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer titkos" } }),
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("409 → running", async () => {
    await expect(runHubJob("news-evening", HUB_ENV, io({ fetch: vi.fn().mockResolvedValue(res(409)) }))).resolves.toBe("running");
  });

  it("más hiba → dob, a HTTP-állapottal; nem esik át a CLI-re (a kulcs megvolt, a hub válaszolt)", async () => {
    const execFile = vi.fn();
    await expect(runHubJob("news-evening", { ...HUB_ENV, TG_HUB_ROOT: ROOT }, io({ fetch: vi.fn().mockResolvedValue(res(500)), execFile }))).rejects.toThrow(/HTTP 500/);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("runHubJob: kézi futásnál a hub CLI-jén át (TG_HUB_ROOT)", () => {
  it("a CLI run-job parancsát hívja a portfolio app-azonosítójával; 0-s kilépés → started", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "Elindítva: portfolio/news-evening — az eredményt a /status mutatja.\n", stderr: "" });
    await expect(runHubJob("news-evening", { TG_HUB_ROOT: ROOT }, io({ execFile }))).resolves.toBe("started");
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([resolve(ROOT, "src", "cli.ts"), "run-job", "--app", "portfolio", "--job", "news-evening"]);
  });

  it("a TG_HUB_APP felülírja az app-azonosítót (ha a hub megadja)", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "Elindítva", stderr: "" });
    await runHubJob("news-morning", { TG_HUB_ROOT: ROOT, TG_HUB_APP: "masik" }, io({ execFile }));
    expect(execFile.mock.calls[0][1]).toContain("masik");
  });

  it("a CLI „Nem indult (409)” hibája → running (már fut a job)", async () => {
    const execFile = vi.fn().mockRejectedValue(cliError("Nem indult (409): a job már fut"));
    await expect(runHubJob("news-morning", { TG_HUB_ROOT: ROOT }, io({ execFile }))).resolves.toBe("running");
  });

  it("a CLI más hibája → dob, a CLI üzenetével (pl. a hub nem fut)", async () => {
    const execFile = vi.fn().mockRejectedValue(cliError("A hub nem fut."));
    await expect(runHubJob("news-morning", { TG_HUB_ROOT: ROOT }, io({ execFile }))).rejects.toThrow(/A hub nem fut\./);
  });

  it("ha a CLI nem indítható (nincs fájl, időtúllépés), a hiba érthető", async () => {
    const execFile = vi.fn().mockRejectedValue(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await expect(runHubJob("news-morning", { TG_HUB_ROOT: ROOT }, io({ execFile }))).rejects.toThrow(/tg-hub CLI|ENOENT/);
  });

  it("hiányos hub-környezetnél (pl. csak az URL) is a CLI-re esik vissza, nem dob kulcshiányt", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "Elindítva", stderr: "" });
    await expect(runHubJob("news-morning", { TG_HUB_URL: "http://x", TG_HUB_ROOT: ROOT }, io({ execFile }))).resolves.toBe("started");
  });
});

describe("runHubJob: egyik út sem áll rendelkezésre", () => {
  it("érthető hibát ad, és nem hív semmit", async () => {
    const i = io();
    await expect(runHubJob("news-morning", {}, i)).rejects.toThrow(/csak a tg-hubon keresztül indítható/);
    expect(i.fetch).not.toHaveBeenCalled();
    expect(i.execFile).not.toHaveBeenCalled();
  });
});
