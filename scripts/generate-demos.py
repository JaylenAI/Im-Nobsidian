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


# ============================================================
# Demo 5: nobsi push (Push to Notion)
# ============================================================
def generate_push_demo():
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi push", t)
    t = newline(events, t, 0.3)

    t += 0.5
    t = output_line(events, t, f"\r\n{BOLD}  Pushing to Notion...{RESET}", 0.2)
    t += 0.3

    pages = [
        ("Dev Notes/Refactoring Plan", "create"),
        ("Dev Notes/Performance Tuning", "create"),
        ("Meeting Notes/2026-05-20", "create"),
        ("README", "update"),
        ("Roadmap", "update"),
    ]

    for i, (name, op) in enumerate(pages):
        t += 0.3
        if op == "create":
            icon = f"{GREEN}+{RESET}"
            label = f"{GREEN}created{RESET}"
        else:
            icon = f"{YELLOW}~{RESET}"
            label = f"{YELLOW}updated{RESET}"

        progress = f"{DIM}[{i+1}/{len(pages)}]{RESET}"
        events.append([round(t, 3), "o", f"  {icon} {name} {progress} {label}\r\n"])

    t += 0.5
    events.append([round(t, 3), "o", f"\r\n  {BOLD}{GREEN}Push complete{RESET}\r\n"])
    t = output_line(events, t, f"  {GREEN}3 created{RESET}  {YELLOW}2 updated{RESET}  {DIM}0 failed{RESET}", 0.2)
    t = output_line(events, t, f"  {DIM}Done in 2.8s{RESET}", 0.15)

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("push.cast", events, title="nobsi push — Push to Notion")


# ============================================================
# Demo 6: nobsi diff (Show Differences)
# ============================================================
def generate_diff_demo():
    RED = "\033[31m"
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi diff Project Proposal.md", t)
    t = newline(events, t, 0.3)

    t += 0.5
    t = output_line(events, t, f"{BOLD}--- a/Project Proposal.md{RESET}", 0.1)
    t = output_line(events, t, f"{BOLD}+++ b/Project Proposal.md{RESET}", 0.1)
    t = output_line(events, t, f"{CYAN}@@ -1,8 +1,10 @@{RESET}", 0.1)
    t = output_line(events, t, " ---", 0.05)
    t = output_line(events, t, " title: Project Proposal", 0.05)
    t = output_line(events, t, f"{GREEN}+status: In Progress{RESET}", 0.08)
    t = output_line(events, t, f"{GREEN}+priority: 1{RESET}", 0.08)
    t = output_line(events, t, " ---", 0.05)
    t = output_line(events, t, " ", 0.05)
    t = output_line(events, t, f"{RED}-## Overview{RESET}", 0.08)
    t = output_line(events, t, f"{GREEN}+## Project Overview{RESET}", 0.08)
    t = output_line(events, t, " ", 0.05)
    t = output_line(events, t, f"{RED}-This document outlines the initial plan.{RESET}", 0.08)
    t = output_line(events, t, f"{GREEN}+This document outlines the revised project plan{RESET}", 0.08)
    t = output_line(events, t, f"{GREEN}+with updated timeline and milestones.{RESET}", 0.08)

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("diff.cast", events, title="nobsi diff — Show Differences")


# ============================================================
# Demo 7: nobsi resolve (Resolve Conflicts)
# ============================================================
def generate_resolve_demo():
    RED = "\033[31m"
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi resolve", t)
    t = newline(events, t, 0.3)

    t += 0.6
    t = output_line(events, t, f"\r\n{BOLD}충돌 2건 발견{RESET}\r\n", 0.2)

    # Conflict 1
    t += 0.3
    t = output_line(events, t, f"{'─' * 56}", 0.1)
    t = output_line(events, t, f"파일: {BOLD}README.md{RESET}", 0.1)
    t = output_line(events, t, f"{'─' * 56}", 0.1)
    t += 0.2
    t = output_line(events, t, f"{BOLD}--- local{RESET}", 0.1)
    t = output_line(events, t, f"{BOLD}+++ remote{RESET}", 0.1)
    t = output_line(events, t, f"{RED}- # My Project{RESET}", 0.08)
    t = output_line(events, t, f"{GREEN}+ # My Project (Updated){RESET}", 0.08)
    t = output_line(events, t, f"{RED}- Version: 0.1.5{RESET}", 0.08)
    t = output_line(events, t, f"{GREEN}+ Version: 0.1.6{RESET}", 0.08)

    t += 0.4
    t = output_line(events, t, f"\r\n{YELLOW}?{RESET} 어떻게 해결할까요?", 0.2)
    t += 0.2
    t = output_line(events, t, f"  {CYAN}▸ 로컬 유지 (Obsidian 버전 유지){RESET}", 0.1)
    t = output_line(events, t, f"    원격 유지 (Notion 버전으로 덮어쓰기)", 0.1)
    t = output_line(events, t, f"    자동 병합 (3-way merge)", 0.1)
    t = output_line(events, t, f"    복제 (.conflict 파일 생성)", 0.1)
    t += 1.0
    events.append([round(t, 3), "o", f"\r\n{GREEN}✓ README.md → local로 해결{RESET}\r\n"])

    # Conflict 2
    t += 0.5
    t = output_line(events, t, f"\r\n{'─' * 56}", 0.1)
    t = output_line(events, t, f"파일: {BOLD}Dev Notes/API Guide.md{RESET}", 0.1)
    t = output_line(events, t, f"{'─' * 56}", 0.1)
    t += 0.2
    t = output_line(events, t, f"{BOLD}--- local{RESET}", 0.1)
    t = output_line(events, t, f"{BOLD}+++ remote{RESET}", 0.1)
    t = output_line(events, t, f"{RED}- endpoint: /api/v1/sync{RESET}", 0.08)
    t = output_line(events, t, f"{GREEN}+ endpoint: /api/v2/sync{RESET}", 0.08)

    t += 0.4
    t = output_line(events, t, f"\r\n{YELLOW}?{RESET} 어떻게 해결할까요?", 0.2)
    t += 0.2
    t = output_line(events, t, f"    로컬 유지 (Obsidian 버전 유지)", 0.1)
    t = output_line(events, t, f"  {CYAN}▸ 원격 유지 (Notion 버전으로 덮어쓰기){RESET}", 0.1)
    t = output_line(events, t, f"    자동 병합 (3-way merge)", 0.1)
    t = output_line(events, t, f"    복제 (.conflict 파일 생성)", 0.1)
    t += 0.8
    events.append([round(t, 3), "o", f"\r\n{GREEN}✓ Dev Notes/API Guide.md → remote로 해결{RESET}\r\n"])

    t += 0.4
    t = output_line(events, t, f"\r\n{BOLD}충돌 해결 완료{RESET}", 0.2)

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("resolve.cast", events, height=36, title="nobsi resolve — Resolve Conflicts")


# ============================================================
# Demo 8: nobsi watch (Watch + Auto Sync)
# ============================================================
def generate_watch_demo():
    events = []
    t = 0.0

    t = prompt(events, t, 0.5)
    t = type_text(events, "nobsi watch", t)
    t = newline(events, t, 0.3)

    t += 0.5
    events.append([round(t, 3), "o", f"\r\n{DIM}[23:45:12]{RESET} 파일 감시 시작 {DIM}(debounce: 2000ms){RESET}\r\n"])

    # Event 1: file change
    t += 1.5
    events.append([round(t, 3), "o", f"{DIM}[23:45:18]{RESET} {YELLOW}change:{RESET} notes/plan.md\r\n"])
    t += 2.0
    events.append([round(t, 3), "o", f"{DIM}[23:45:20]{RESET} 동기화 시작...\r\n"])
    t += 3.0
    events.append([round(t, 3), "o", f"{DIM}[23:45:24]{RESET} {GREEN}동기화 완료{RESET} — Pull: +0 ~0 -0 | Push: +0 ~1 -0\r\n"])

    # Event 2: new file
    t += 2.0
    events.append([round(t, 3), "o", f"{DIM}[23:46:03]{RESET} {CYAN}add:{RESET} notes/new-idea.md\r\n"])
    t += 2.0
    events.append([round(t, 3), "o", f"{DIM}[23:46:05]{RESET} 동기화 시작...\r\n"])
    t += 2.5
    events.append([round(t, 3), "o", f"{DIM}[23:46:08]{RESET} {GREEN}동기화 완료{RESET} — Pull: +0 ~0 -0 | Push: +1 ~0 -0\r\n"])

    # Event 3: another change
    t += 2.0
    events.append([round(t, 3), "o", f"{DIM}[23:47:30]{RESET} {YELLOW}change:{RESET} README.md\r\n"])
    t += 2.0
    events.append([round(t, 3), "o", f"{DIM}[23:47:32]{RESET} 동기화 시작...\r\n"])
    t += 2.5
    events.append([round(t, 3), "o", f"{DIM}[23:47:35]{RESET} {GREEN}동기화 완료{RESET} — Pull: +0 ~1 -0 | Push: +0 ~1 -0\r\n"])

    # Ctrl+C
    t += 2.0
    events.append([round(t, 3), "o", "^C\r\n"])
    t += 0.3
    events.append([round(t, 3), "o", f"{DIM}[23:47:40]{RESET} 감시 종료 중...\r\n"])
    t += 0.2
    events.append([round(t, 3), "o", f"{DIM}[23:47:40]{RESET} 종료 완료\r\n"])

    t = prompt(events, t, 0.8)
    t += 1.5

    write_cast("watch.cast", events, title="nobsi watch — Watch + Auto Sync")


if __name__ == "__main__":
    print("Generating demo .cast files...")
    generate_init_demo()
    generate_pull_demo()
    generate_push_demo()
    generate_sync_demo()
    generate_status_demo()
    generate_diff_demo()
    generate_resolve_demo()
    generate_watch_demo()
    print("Done!")
