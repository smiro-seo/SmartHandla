# CLAUDE.md - Project Intelligence & GSD Framework

This file is the primary context source for Claude Code. Follow the GSD (Get Shit Done) workflow for all tasks.

## 🚀 GSD Workflow Rules
1. **Spec First**: Every change begins with a file in `/specs` using OpenSpec format.
2. **Memory Management**: If context window feels cluttered, run `/clear`. This file and active specs provide all necessary re-hydration.
3. **Verification**: Always use Playwright MCP to verify UI changes before declaring a task finished.
4. **Safety**: Do not refactor `App.tsx` unless explicitly instructed; focus on modularity for new features.

## 🛠 Commands
```bash
npm install        # Install dependencies
npm run dev        # Start dev server at http://localhost:3000
npm run build      # Production build
npm run preview    # Preview production build
# MCP Commands (Implicitly available via Claude Code)
# - playwright_mcp: Use for UI testing & visual verification
# - supabase_mcp: Use for DB schema inspection/migrations
# - duckduckgo_mcp: Use for external documentation search