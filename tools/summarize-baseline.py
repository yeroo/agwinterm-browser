"""Summarise a `cargo check --message-format short` capture by file and error code."""

import collections
import re
import sys

BS = chr(92)
PAT = re.compile(r"^(crates[" + BS + BS + "/][^:]+" + BS + r".rs):(\d+):\d+: (error" + BS + r"[E\d+" + BS + r"])")


def summarize(path):
    per_file = collections.Counter()
    per_pair = collections.Counter()
    for line in open(path, encoding="utf-8-sig"):
        m = PAT.match(line)
        if not m:
            continue
        f = m.group(1).replace(BS, "/")
        per_file[f] += 1
        per_pair[(f, m.group(3))] += 1
    return per_file, per_pair


for path in sys.argv[1:]:
    per_file, per_pair = summarize(path)
    print("==", path, sum(per_file.values()))
    for f, n in per_file.most_common():
        print("  ", n, f)
    for (f, code), n in sorted(per_pair.items()):
        print("    ", n, f, code)
