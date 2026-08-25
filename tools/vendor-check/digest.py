"""Content digest of a source tree, ignoring build output.

Used to record what was vendored when the upstream checkout carries no VCS
metadata. Walks in sorted order so the digest is reproducible.
"""

import hashlib
import os
import sys

SKIP = {"node_modules", "target", "dist", ".git", "out"}
SEP = chr(92)


def digest(root):
    h = hashlib.sha256()
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP)
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root).replace(SEP, "/")
            h.update(rel.encode())
            with open(path, "rb") as fh:
                h.update(fh.read())
            count += 1
    return count, h.hexdigest()


if __name__ == "__main__":
    for root in sys.argv[1:]:
        count, value = digest(root)
        print(f"{root}: {count} files, sha256 {value}")
