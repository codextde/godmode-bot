/** Plugins Godmode recommends: whole Claude Code plugins installed from their GitHub repositories. */
import type { ModCatalogEntry } from "@godmode/shared";

const CATALOG: ModCatalogEntry[] = [
  {
    id: "claude-video",
    title: "Claude Video",
    description: "Lets agents watch videos: a YouTube, TikTok or Vimeo link or a local file becomes timestamped frames and a transcript.",
    icon: "video",
    repo: "bradautomates/claude-video",
    author: "Bradley Bonanno",
    license: "MIT",
    highlights: [
      "The /watch skill downloads the video, pulls timestamped frames and its captions",
      "Transcribes with local WhisperX, Groq or OpenAI when there are no captions",
      "Works with links from most video sites and with files on this computer",
    ],
    requires: ["Python 3.10+", "ffmpeg", "yt-dlp"],
    usage: "/watch https://youtu.be/…",
  },
  {
    id: "oh-my-claudecode",
    title: "oh-my-claudecode",
    description: "Multi-agent orchestration: specialist subagents and workflows that plan, build, review and verify work in parallel.",
    icon: "layers",
    repo: "Yeachan-Heo/oh-my-claudecode",
    author: "Yeachan Heo",
    license: "MIT",
    highlights: [
      "19 specialist subagents: planner, architect, executor, code reviewer, verifier and more",
      "Workflows like autopilot, ralph, team and deep-interview, started by a keyword or a skill",
      "Its own tools over an MCP server, plus hooks that keep long tasks on track",
    ],
    requires: ["Node.js 20+"],
    usage: "autopilot: build a REST API for tasks",
  },
];

export function listCatalog(): ModCatalogEntry[] {
  return CATALOG;
}

export function findCatalogEntry(id: string): ModCatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}
