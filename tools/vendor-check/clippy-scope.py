"""Attribute every clippy warning to the commit that wrote the line it points at.

Same problem and same disposition as `fmt-scope.py`: the vendored tree does not
pass `cargo clippy -- -D warnings` and never did, and silencing it would mean
editing the 43 files the port promises to leave alone. So the checkable claim is
*no clippy warning lands on a line this port wrote*.

Prints the port-authored warnings and exits non-zero if there are any.
"""

import collections
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASELINE = "45b5e43"
WARNING = re.compile(r"^(.+?):(\d+):\d+: warning: (.*)$")


def warnings():
    proc = subprocess.run(
        ["cargo", "clippy", "--workspace", "--all-targets", "--message-format", "short"],
        cwd=os.path.join(REPO, "engine"),
        capture_output=True,
        text=True,
    )
    # A workspace that does not compile emits errors, not warnings, so the regex
    # below matches nothing and the whole check would report "0 warnings" and exit
    # green -- which is exactly backwards. cargo's exit code is the only thing that
    # separates "clean" from "never ran".
    if proc.returncode != 0 and "warning:" not in proc.stderr:
        sys.stderr.write(proc.stderr)
        sys.stderr.write(
            f"cargo clippy exited {proc.returncode} without producing warnings: "
            "the workspace does not build, so nothing was checked.\n"
        )
        raise SystemExit(2)
    found = {}
    for line in proc.stderr.splitlines() + proc.stdout.splitlines():
        m = WARNING.match(line.strip())
        if not m:
            continue
        path = m.group(1).replace(chr(92), "/")
        if not path.startswith("crates/"):
            continue
        found[(f"engine/{path}", int(m.group(2)))] = m.group(3)
    return found


def blame(path, line):
    out = subprocess.run(
        ["git", "blame", "-L", f"{line},{line}", "--porcelain", "HEAD", "--", path],
        cwd=REPO,
        capture_output=True,
        text=True,
    ).stdout
    return out.split("\n")[0][:9] if out else "?"


def main():
    found = warnings()
    port = collections.defaultdict(list)
    vendored = 0
    for (path, line), text in sorted(found.items()):
        if blame(path, line).startswith(BASELINE):
            vendored += 1
        else:
            port[path].append((line, text))
    charged = sum(len(v) for v in port.values())
    print(f"clippy warnings: {len(found)}  on vendored lines: {vendored}  on port lines: {charged}")
    for path, items in sorted(port.items()):
        for line, text in items:
            print(f"  {path}:{line}: {text}")
    return 1 if port else 0


if __name__ == "__main__":
    sys.exit(main())
