# @umigame-tech/dura

Command-line client for [dura](https://github.com/umigame-tech/dura), the shared state server for AI agent loops.
It has no dependencies and needs Node.js 20 or later.

```bash
npm install -g @umigame-tech/dura
```

Set the server and your token in the environment. The token is never taken as a flag value, so it stays out of shell history:
use `DURA_TOKEN`, or `--token-file <path>` / `--token-stdin` to read it from a file or stdin.
With `--token-stdin`, pass the body of `log` / `section put` with `--file` (or `log` message arguments).
State commands use `DURA_STATE`, or `--state <id>`. `--url <url>` overrides `DURA_URL`.
`dura guide` reads a public endpoint, so it works without `DURA_TOKEN`.

```bash
export DURA_URL=https://dura.example.com DURA_TOKEN=... DURA_STATE=search-rewrite
```

```
dura show                                   Every section and the journal (Markdown; --json for JSON)
dura list                                   States you can read
dura section get tasks                      Body to stdout, version to stderr
dura section put plan --version 3 < plan.md Write a whole section (omit --version to create one)
dura section replace tasks --version 7 --old "- [ ] CI" --new "- [x] CI"
dura log --kind report "Added CI"           Append to the journal (argument, stdin, or --file)
dura journal --after 41                     Journal entries after a seq
dura journal --before 1000000000 --limit 20 The latest 20 entries (--max-chars 500 cuts long bodies)
dura journal 37                             One whole journal entry
dura search SQLite --kind decision          Search the journal, newest first (every keyword must occur)
dura summary get                            Journal summary to stdout, its version and covered seq to stderr
dura summary put --covered 41 --version 3 < summary.md  Write the summary (omit --version to create it)
dura status waiting --note "Which name?"
dura guide                                  Print /api/guide
```

Run `dura --help` for every option, and `dura guide` for how agents should use dura.
A command fails (exit code 2, nothing sent) when it gets a flag or an argument it does not take, e.g. `dura show --kind x` or `dura show extra`.

## License

MIT
