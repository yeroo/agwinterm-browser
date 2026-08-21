"""Attribute every `cargo fmt --check` diff to the commit that wrote the line.

The vendored tree is not rustfmt-clean and reformatting it is the silent edit the
port's Constraints forbid (see `docs/design/01-baseline-errors.md`), so
`cargo fmt --all --check` cannot be green here. The checkable claim that replaces
it is narrower and stronger: *no rustfmt complaint lands on a line this port wrote*.

rustfmt reports `Diff in <file>:<n>:` where `n` is the first line of the shown
context, not the line it objects to — so blaming `n` would attribute a vendored
misformat to whichever commit happened to add a nearby module declaration. What is
blamed here is each *removed* line, which is a real line of the file today and is
the thing rustfmt wants gone. Added (`+`) lines have no line number yet and are
skipped; a pure insertion is attributed to the context line above it.

Prints the port-authored complaints and exits non-zero if there are any.
"""

import collections
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASELINE = "45b5e43"
HEADER = re.compile(r"^Diff in (.*):(\d+):$")
ANSI = re.compile(r"\x1b\[[0-9;]*m")
UNC = chr(92) + chr(92) + "?" + chr(92)


def complaints():
    """Every (path, line) rustfmt objects to, one per removed or displaced line."""
    out = subprocess.run(
        ["cargo", "fmt", "--all", "--check"],
        cwd=os.path.join(REPO, "engine"),
        capture_output=True,
        text=True,
    ).stdout
    found = []
    path, line = None, 0
    for raw in out.splitlines():
        clean = ANSI.sub("", raw)
        header = HEADER.match(clean.strip())
        if header:
            path = header.group(1).replace(UNC, "").replace(chr(92), "/")
            if "winterm-browser/" in path:
                path = path.split("winterm-browser/", 1)[1]
            line = int(header.group(2))
            continue
        if path is None:
            continue
        if clean.startswith("+"):
            # An inserted line has no number of its own; charge it to the line above.
            found.append((path, max(1, line - 1)))
        elif clean.startswith("-"):
            found.append((path, line))
            line += 1
        else:
            line += 1
    return sorted(set(found))


def blame(path, line):
    out = subprocess.run(
        ["git", "blame", "-L", f"{line},{line}", "--porcelain", "HEAD", "--", path],
        cwd=REPO,
        capture_output=True,
        text=True,
    ).stdout
    return out.split("\n")[0][:9] if out else "?"


def main():
    port = collections.defaultdict(list)
    vendored = 0
    found = complaints()
    for path, line in found:
        if blame(path, line).startswith(BASELINE):
            vendored += 1
        else:
            port[path].append(line)
    total = len(found)
    charged = sum(len(v) for v in port.values())
    print(f"rustfmt complaints: {total}  on vendored lines: {vendored}  on port lines: {charged}")
    for path, lines in sorted(port.items()):
        print(f"  {path}: {', '.join(str(n) for n in lines)}")
    return 1 if port else 0


if __name__ == "__main__":
    sys.exit(main())
