# tokybook-downloader

requires `bun` and `ffmpeg`
---
install `bun` with:
```bash
# linux/macOS:
curl -fsSL https://bun.sh/install | bash

# windows:
powershell -c "irm bun.sh/install.ps1 | iex"
```

install `ffmpeg` with:
```bash
# ubuntu/debian:
sudo apt update
sudo apt install ffmpeg

# fedora:
sudo dnf install ffmpeg

# arch linux:
sudo pacman -S ffmpeg

# alpine:
sudo apk add ffmpeg

# macOS
brew install ffmpeg
# install brew with:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# windows:
winget install ffmpeg
```

to install dependencies:
---

```bash
bun install
```

to run:
---

```bash
bun run server.js
```

this project was created using `bun init` in bun v1.1.42. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
