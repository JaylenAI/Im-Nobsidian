#!/usr/bin/env python3
"""Generate asciinema .cast files for Im-Nobsidian demo animations."""

import json
import os

ASSETS_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "demo")
os.makedirs(ASSETS_DIR, exist_ok=True)

# ANSI color codes
GREEN = "\033[32m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"
WHITE = "\033[37m"
BG_GREEN = "\033[42m"
BG_BLUE = "\033[44m"


def write_cast(filename, events, width=72, height=24, title=""):
    header = {
        "version": 2,
        "width": width,
        "height": height,
        "timestamp": 1716163200,
        "title": title,
        "env": {"SHELL": "/bin/bash", "TERM": "xterm-256color"},
    }
    path = os.path.join(ASSETS_DIR, filename)
    with open(path, "w") as f:
        f.write(json.dumps(header) + "\n")
        for event in events:
            f.write(json.dumps(event) + "\n")
    print(f"  Created: {path}")


def type_text(events, text, t, char_delay=0.04):
    for char in text:
        t += char_delay
        events.append([round(t, 3), "o", char])
    return t


def prompt(events, t, delay=0.3):
    t += delay
    events.append([round(t, 3), "o", f"{GREEN}❯{RESET} "])
    return t


def newline(events, t, delay=0.1):
    t += delay
    events.append([round(t, 3), "o", "\r\n"])
    return t


def output_line(events, t, text, delay=0.05):
    t += delay
    events.append([round(t, 3), "o", text + "\r\n"])
    return t


# ============================================================
# Demo 1: nobsi init (Interactive Setup)
# ============================================================
def generate_init_demo():
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi init", t)
    t = newline(events, t, 0.3)

    t += 0.5
    events.append([round(t, 3), "o", f"\r\n{BOLD}{CYAN}  Im-Nobsidian Setup{RESET}\r\n"])
    t = output_line(events, t, f"  {DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{RESET}", 0.1)
    t += 0.3

    t = output_line(events, t, f"\r\n  {YELLOW}?{RESET} Notion Integration Token:", 0.2)
    t += 0.3
    events.append([round(t, 3), "o", f"    {DIM}ntn_{RESET}"])
    t = type_text(events, "••••••••••••••••••", t, 0.03)
    t = newline(events, t, 0.3)

    t += 0.5
    events.append([round(t, 3), "o", f"  {GREEN}✓{RESET} Token validated\r\n"])

    t += 0.6
    t = output_line(events, t, f"\r\n  {YELLOW}?{RESET} Select root page:", 0.2)
    t += 0.3
    t = output_line(events, t, f"    {DIM}1.{RESET} My Workspace", 0.1)
    t = output_line(events, t, f"    {DIM}2.{RESET} {CYAN}▸ Im-Nobsidian Demo{RESET}", 0.1)
    t = output_line(events, t, f"    {DIM}3.{RESET} Project Notes", 0.1)
    t += 0.8
    events.append([round(t, 3), "o", f"    {DIM}Selected:{RESET} {BOLD}Im-Nobsidian Demo{RESET}\r\n"])

    t += 0.5
    t = output_line(events, t, f"\r\n  {YELLOW}?{RESET} Sync direction: {CYAN}both{RESET} (bidirectional)", 0.2)
    t += 0.3
    t = output_line(events, t, f"  {YELLOW}?{RESET} Conflict strategy: {CYAN}ask{RESET}", 0.2)

    t += 0.6
    t = output_line(events, t, f"\r\n  {GREEN}✓{RESET} Config saved to {DIM}.im-nobsidian/config.json{RESET}", 0.2)
    t = output_line(events, t, f"  {GREEN}✓{RESET} State DB initialized", 0.15)
    t += 0.3
    t = output_line(events, t, f"\r\n  {BOLD}{GREEN}Ready!{RESET} Run {CYAN}nobsi sync{RESET} to start syncing.", 0.2)

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("init.cast", events, title="nobsi init — Interactive Setup")


# ============================================================
# Demo 2: nobsi pull (Pull from Notion)
# ============================================================
def generate_pull_demo():
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi pull", t)
    t = newline(events, t, 0.3)

    t += 0.5
    t = output_line(events, t, f"\r\n{BOLD}  Pulling from Notion...{RESET}", 0.2)
    t += 0.3

    pages = [
        ("Project Proposal", "create"),
        ("Meeting Notes/2026-05-15", "create"),
        ("Meeting Notes/2026-05-19", "create"),
        ("Dev Notes/Architecture Design", "create"),
        ("Dev Notes/API Integration Guide", "create"),
        ("Dev Notes/Deploy Checklist", "create"),
        ("README", "update"),
        ("Roadmap", "create"),
    ]

    for i, (name, op) in enumerate(pages):
        t += 0.25
        if op == "create":
            icon = f"{GREEN}+{RESET}"
            label = f"{GREEN}created{RESET}"
        else:
            icon = f"{YELLOW}~{RESET}"
            label = f"{YELLOW}updated{RESET}"

        progress = f"{DIM}[{i+1}/{len(pages)}]{RESET}"
        events.append([round(t, 3), "o", f"  {icon} {name} {progress} {label}\r\n"])

    t += 0.5
    events.append([round(t, 3), "o", f"\r\n  {GREEN}✓{RESET} 12 images → {DIM}attachments/{RESET}\r\n"])
    t += 0.15
    events.append([round(t, 3), "o", f"  {GREEN}✓{RESET} 3 files → {DIM}attachments/{RESET}\r\n"])
    t += 0.15
    events.append([round(t, 3), "o", f"  {GREEN}✓{RESET} 24 links resolved\r\n"])

    t += 0.5
    events.append([round(t, 3), "o", f"\r\n  {BOLD}{GREEN}Pull complete{RESET}\r\n"])
    t = output_line(events, t, f"  {GREEN}7 created{RESET}  {YELLOW}1 updated{RESET}  {DIM}0 failed{RESET}", 0.2)
    t = output_line(events, t, f"  {DIM}Done in 3.2s{RESET}", 0.15)

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("pull.cast", events, title="nobsi pull — Pull from Notion")


# ============================================================
# Demo 3: nobsi sync (Bidirectional Sync)
# ============================================================
def generate_sync_demo():
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi sync", t)
    t = newline(events, t, 0.3)

    t += 0.5
    events.append([round(t, 3), "o", f"\r\n{BOLD}  Bidirectional Sync{RESET}\r\n"])
    t = output_line(events, t, f"  {DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{RESET}", 0.1)

    # Pull phase
    t += 0.4
    events.append([round(t, 3), "o", f"\r\n  {BOLD}{BLUE}▼ Pull{RESET} {DIM}(Notion → Obsidian){RESET}\r\n"])
    t += 0.3

    pull_pages = [
        ("Meeting Notes/Sprint Review", "create"),
        ("Project Proposal", "update"),
    ]
    for i, (name, op) in enumerate(pull_pages):
        t += 0.2
        icon = f"{GREEN}+{RESET}" if op == "create" else f"{YELLOW}~{RESET}"
        label = f"{GREEN}created{RESET}" if op == "create" else f"{YELLOW}updated{RESET}"
        events.append([round(t, 3), "o", f"    {icon} {name} {label}\r\n"])

    t += 0.3
    t = output_line(events, t, f"    {GREEN}✓{RESET} 4 images downloaded", 0.15)
    t = output_line(events, t, f"    {GREEN}✓{RESET} 8 links resolved", 0.1)

    # Push phase
    t += 0.5
    events.append([round(t, 3), "o", f"\r\n  {BOLD}{MAGENTA}▲ Push{RESET} {DIM}(Obsidian → Notion){RESET}\r\n"])
    t += 0.3

    push_pages = [
        ("Dev Notes/Refactoring Plan", "create"),
        ("README", "update"),
        ("Roadmap", "update"),
    ]
    for i, (name, op) in enumerate(push_pages):
        t += 0.25
        icon = f"{GREEN}+{RESET}" if op == "create" else f"{YELLOW}~{RESET}"
        label = f"{GREEN}created{RESET}" if op == "create" else f"{YELLOW}updated{RESET}"
        events.append([round(t, 3), "o", f"    {icon} {name} {label}\r\n"])

    # Summary
    t += 0.5
    events.append([round(t, 3), "o", f"\r\n  {BOLD}{GREEN}Sync complete{RESET}\r\n"])
    t = output_line(events, t, f"  {BLUE}Pull:{RESET} {GREEN}1 created{RESET}  {YELLOW}1 updated{RESET}", 0.15)
    t = output_line(events, t, f"  {MAGENTA}Push:{RESET} {GREEN}1 created{RESET}  {YELLOW}2 updated{RESET}", 0.15)
    t = output_line(events, t, f"  {DIM}Done in 4.7s{RESET}", 0.1)

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("sync.cast", events, title="nobsi sync — Bidirectional Sync")


# ============================================================
# Demo 4: nobsi status (Sync Status)
# ============================================================
def generate_status_demo():
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi status", t)
    t = newline(events, t, 0.3)

    t += 0.5
    events.append([round(t, 3), "o", f"\r\n{BOLD}  Sync Status{RESET}\r\n"])
    t = output_line(events, t, f"  {DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━{RESET}", 0.1)

    t += 0.3
    t = output_line(events, t, f"  {DIM}Root page:{RESET}  35a13b18...", 0.1)
    t = output_line(events, t, f"  {DIM}Direction:{RESET}  bidirectional", 0.1)
    t = output_line(events, t, f"  {DIM}Last sync:{RESET}  2026-05-19 23:45:12", 0.1)

    t += 0.3
    events.append([round(t, 3), "o", f"\r\n  {BOLD}Tracked files: 42{RESET}\r\n"])
    t += 0.2
    t = output_line(events, t, f"  {GREEN}●{RESET} {GREEN}synced{RESET}     38", 0.1)
    t = output_line(events, t, f"  {YELLOW}●{RESET} {YELLOW}modified{RESET}   2", 0.1)
    t = output_line(events, t, f"  {CYAN}●{RESET} {CYAN}new{RESET}        1", 0.1)
    t = output_line(events, t, f"  {MAGENTA}●{RESET} {MAGENTA}conflict{RESET}   1", 0.1)

    t += 0.3
    events.append([round(t, 3), "o", f"\r\n  {BOLD}Modified files:{RESET}\r\n"])
    t += 0.1
    t = output_line(events, t, f"    {YELLOW}~{RESET} Project Proposal.md       {DIM}(local changed){RESET}", 0.1)
    t = output_line(events, t, f"    {YELLOW}~{RESET} Dev Notes/API Guide.md    {DIM}(local changed){RESET}", 0.1)

    t += 0.2
    events.append([round(t, 3), "o", f"\r\n  {BOLD}New files:{RESET}\r\n"])
    t += 0.1
    t = output_line(events, t, f"    {CYAN}+{RESET} Meeting Notes/2026-05-20.md {DIM}(untracked){RESET}", 0.1)

    t += 0.2
    events.append([round(t, 3), "o", f"\r\n  {BOLD}{MAGENTA}Conflicts:{RESET}\r\n"])
    t += 0.1
    t = output_line(events, t, f"    {MAGENTA}!{RESET} README.md                 {DIM}(both sides changed){RESET}", 0.1)
    t += 0.2
    t = output_line(events, t, f"\r\n  {DIM}Run{RESET} {CYAN}nobsi resolve{RESET} {DIM}to resolve conflicts{RESET}", 0.15)
    t = output_line(events, t, f"  {DIM}Run{RESET} {CYAN}nobsi sync{RESET} {DIM}to push/pull changes{RESET}", 0.15)

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("status.cast", events, height=28, title="nobsi status — Sync Status")


if __name__ == "__main__":
    print("Generating demo .cast files...")
    generate_init_demo()
    generate_pull_demo()
    generate_sync_demo()
    generate_status_demo()
    print("Done!")
