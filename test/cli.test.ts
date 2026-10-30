import { describe, expect, it } from "vitest";
import { run, type Io } from "../cli/src/cli";
import { setup } from "./helpers";

async function cli() {
  const ctx = await setup();
  const token = await ctx.tokenFor("cli-agent");
  await ctx.call(token, "POST", "/api/states", { id: "s", title: "S", sections: { tasks: "- [ ] a\n- [ ] b\n" } });

  const exec = async (
    argv: string[],
    opts: { stdin?: string; env?: Record<string, string | undefined>; files?: Record<string, string> } = {},
  ) => {
    let stdout = "";
    let stderr = "";
    const urls: string[] = [];
    const auth: (string | null)[] = [];
    const io: Io = {
      env: { DURA_URL: "http://localhost/", DURA_TOKEN: token, DURA_STATE: "s", ...opts.env },
      fetch: (url, init) => {
        urls.push(url);
        auth.push(new Headers(init.headers).get("Authorization"));
        return ctx.app.request(url, init) as unknown as Promise<Response>;
      },
      readStdin: async () => opts.stdin ?? "",
      readFile: async (path) => opts.files?.[path] ?? `file:${path}`,
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
    };
    const code = await run(argv, io);
    return { code, stdout, stderr, urls, auth };
  };
  return { ...ctx, token, exec };
}

describe("cli", () => {
  it("requires DURA_URL and DURA_TOKEN, and a state", async () => {
    const { exec } = await cli();
    const missing = await exec(["show"], { env: { DURA_URL: undefined, DURA_TOKEN: undefined } });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Set DURA_URL (or pass --url) and DURA_TOKEN in the environment.");

    const noState = await exec(["show"], { env: { DURA_STATE: undefined } });
    expect(noState.code).toBe(2);
    expect(noState.stderr).toContain("--state");
  });

  it("shows a state as Markdown, or JSON with --json", async () => {
    const { exec } = await cli();
    const md = await exec(["show"]);
    expect(md.code).toBe(0);
    expect(md.stdout).toContain("## Section: tasks");

    const json = await exec(["show", "--state", "s", "--json"]);
    expect(JSON.parse(json.stdout).state.id).toBe("s");

    const unknown = await exec(["show", "-s", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("not_found");
    expect(unknown.stderr).toContain("dura list");
  });

  it("gets, puts and replaces sections with versions", async () => {
    const { exec } = await cli();
    const got = await exec(["section", "get", "tasks"]);
    expect(got.stdout).toBe("- [ ] a\n- [ ] b\n");
    expect(got.stderr).toBe("version: 1\n");
    expect((await exec(["section", "get", "nope"])).stderr).toContain("`dura show` lists the sections");

    const replaced = await exec(["section", "replace", "tasks", "--version", "1", "--old", "- [ ] a", "--new", "- [x] a"]);
    expect(replaced.code).toBe(0);
    expect(replaced.stderr).toBe("Wrote section tasks (version 2).\n");

    const stale = await exec(["section", "replace", "tasks", "--version", "1", "--old", "- [ ] b", "--new", "- [x] b"]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("version_conflict");
    expect(stale.stderr).toContain("Next: Run `dura section get tasks`");
    expect(stale.stderr).toContain("--version 2");

    const noVersion = await exec(["section", "put", "tasks"], { stdin: "x" });
    expect(noVersion.stderr).toContain("pass --version 2");

    expect((await exec(["section", "put", "plan"], { stdin: "# Plan\n" })).code).toBe(0);
    const put = await exec(["section", "put", "tasks", "--version", "2", "--file", "t.md"]);
    expect(put.stderr).toBe("Wrote section tasks (version 3).\n");
    expect((await exec(["section", "get", "tasks"])).stdout).toBe("file:t.md");
  });

  it("appends to and reads the journal", async () => {
    const { exec } = await cli();
    const logged = await exec(["log", "--kind", "report", "did", "the", "thing"]);
    expect(logged.stderr).toBe("Appended report #1.\n");
    await exec(["log"], { stdin: "from stdin\n" });

    const journal = await exec(["journal", "--after", "1"]);
    expect(journal.stdout).toContain("#2 note by cli-agent");
    expect(journal.stdout).not.toContain("did the thing");

    const empty = await exec(["log"], { stdin: "  \n" });
    expect(empty.code).toBe(2);
  });

  it("changes the status", async () => {
    const { exec } = await cli();
    const res = await exec(["status", "waiting", "--note", "Which name?"]);
    expect(res.code).toBe(0);
    const state = JSON.parse((await exec(["show", "--json"])).stdout).state;
    expect(state).toMatchObject({ status: "waiting", statusNote: "Which name?" });

    expect((await exec(["status", "done"])).code).toBe(2);
  });

  it("prints usage and the guide", async () => {
    const { exec } = await cli();
    expect((await exec(["--help"])).stdout).toContain("Usage: dura");
    expect((await exec([])).code).toBe(2);
    expect((await exec(["frobnicate"])).stderr).toContain("Unknown command");
    expect((await exec(["guide"])).stdout).toContain("# dura");
    expect((await exec(["guide", "--json"])).stderr).toContain("only available as Markdown");
  });

  it("reads the guide without a token, and nothing else", async () => {
    const { exec } = await cli();
    const guide = await exec(["guide"], { env: { DURA_TOKEN: undefined } });
    expect(guide.code).toBe(0);
    expect(guide.stdout).toContain("# dura");

    const revoked = await exec(["guide"], { env: { DURA_TOKEN: "dura_revoked" } });
    expect(revoked.code).toBe(0);
    expect(revoked.auth).toEqual([null]);
    expect((await exec(["show"])).auth[0]).toMatch(/^Bearer dura_/);

    const show = await exec(["show"], { env: { DURA_TOKEN: undefined } });
    expect(show.code).toBe(2);
    expect(show.stderr).toContain("Set DURA_TOKEN in the environment.");
  });

  it("reads the token from --token-file or --token-stdin over DURA_TOKEN", async () => {
    const { exec, token } = await cli();
    const noEnv = { DURA_TOKEN: undefined };
    const fromFile = await exec(["show", "--token-file", "/run/dura-token"], { env: noEnv, files: { "/run/dura-token": `${token}\n` } });
    expect(fromFile.code).toBe(0);
    expect(fromFile.auth).toEqual([`Bearer ${token}`]);

    const fromStdin = await exec(["show", "--token-stdin"], { env: { DURA_TOKEN: "dura_other" }, stdin: `${token}\n` });
    expect(fromStdin.code).toBe(0);
    expect(fromStdin.auth).toEqual([`Bearer ${token}`]);

    // The body cannot come from stdin too, but --file and message arguments still work.
    const piped = await exec(["log", "--token-stdin"], { env: noEnv, stdin: token });
    expect(piped.code).toBe(2);
    expect(piped.stderr).toContain("pass the body with --file");
    expect((await exec(["log", "--token-stdin", "done"], { env: noEnv, stdin: token })).code).toBe(0);
    expect((await exec(["log", "--token-stdin", "--file", "r.md"], { env: noEnv, stdin: token })).code).toBe(0);

    const both = await exec(["show", "--token-file", "t", "--token-stdin"], { stdin: token });
    expect(both.stderr).toContain("either --token-file or --token-stdin");
    expect((await exec(["show", "--token-file", "empty"], { files: { empty: "\n" } })).stderr).toContain("is empty");
    expect((await exec(["show", "--token-stdin"], { stdin: "" })).stderr).toContain("empty token");
  });

  it("takes the server URL from --url over DURA_URL", async () => {
    const { exec } = await cli();
    const fromFlag = await exec(["show", "--url", "https://flag.example/"], { env: { DURA_URL: "https://env.example" } });
    expect(fromFlag.code).toBe(0);
    expect(fromFlag.stdout).toContain("## Section: tasks");
    expect(fromFlag.urls).toEqual(["https://flag.example/api/states/s"]);

    const noEnv = await exec(["show", "--url", "https://flag.example"], { env: { DURA_URL: undefined } });
    expect(noEnv.code).toBe(0);
    expect((await exec(["show"], { env: { DURA_URL: "https://env.example" } })).urls).toEqual(["https://env.example/api/states/s"]);

    const withPath = await exec(["show", "--url=https://flag.example/dura/"]);
    expect(withPath.urls).toEqual(["https://flag.example/dura/api/states/s"]);
    expect((await exec(["guide", "--url", "https://flag.example"], { env: { DURA_URL: undefined, DURA_TOKEN: undefined } })).urls).toEqual([
      "https://flag.example/api/guide",
    ]);

    const empty = await exec(["show", "--url", ""]);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("--url must not be empty");

    const bad = await exec(["show", "--url", "localhost"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--url must start with http:// or https://");
  });
});
