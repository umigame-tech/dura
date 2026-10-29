# @umigame-tech/dura

Command-line client for [dura](https://github.com/umigame-tech/dura), the shared state server for AI agent loops.
It has no dependencies and needs Node.js 20 or later.

```bash
npm install -g @umigame-tech/dura
```

Set the server and your token in the environment. The token is read only from `DURA_TOKEN`, never from a flag.
State commands use `DURA_STATE`, or `--state <id>`.

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
dura status waiting --note "Which name?"
dura guide                                  Print /api/guide
```

Run `dura --help` for every option, and `dura guide` for how agents should use dura.

## License

MIT
