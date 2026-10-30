/** Ready-made note templates for the "New note" menu — content is valid Nook markdown. */
import type { IconName } from "@/components/icons";

export type Template = {
  id: string;
  name: string;
  icon: IconName;
  blurb: string;
  title: string;
  content: string;
};

const day = () => {
  const d = new Date();
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
};

export const TEMPLATES: Template[] = [
  {
    id: "journal",
    name: "Daily journal",
    icon: "sun",
    blurb: "Morning pages, wins and worries",
    title: `${day()}`,
    content: `# ${day()}\n\n## Weather check\nMood:  \nEnergy: ⚡⚡⚡\n\n## Three things\n1. \n2. \n3. \n\n## What went well\n- \n\n## Tomorrow\n- [ ] \n`,
  },
  {
    id: "meeting",
    name: "Meeting notes",
    icon: "message-text",
    blurb: "Agenda, decisions, action items",
    title: "Meeting notes",
    content: `# Meeting notes\n\n**Date:** ${day()}  \n**With:** \n\n## Agenda\n1. \n2. \n\n## Notes\n- \n\n## Decisions\n- [x] \n\n## Action items\n- [ ] @me \n- [ ] @them \n`,
  },
  {
    id: "project",
    name: "Project plan",
    icon: "shapes",
    blurb: "Goals, milestones and risks",
    title: "New project",
    content: `# New project\n\n**Status:** sprouting  \n**Deadline:** \n\n## Why\nOne sentence — what does winning look like?\n\n## Milestones\n- [ ] Kickoff\n- [ ] Prototype\n- [ ] First ship\n\n## Risks\n- \n\n## Notes\nSee also the [[Ideas garden]].\n`,
  },
  {
    id: "book",
    name: "Book notes",
    icon: "book-open",
    blurb: "Capture reads, quotes, ideas",
    title: "Book notes",
    content: `# Book notes\n\n**Title:** \n**Author:** \n**Rating:** ★★★☆☆\n\n## Summary in three lines\n\n\n## Quotes worth keeping\n> \n\n## Ideas it sparked\n- \n`,
  },
  {
    id: "bug",
    name: "Bug report",
    icon: "trash",
    blurb: "Steps, expected, actual",
    title: "Bug report",
    content: `# Bug report\n\n**Where:** \n**Severity:** 🟡 minor\n\n## Steps to reproduce\n1. \n2. \n\n## Expected\n\n## Actual\n\n## Fix ideas\n- [ ] \n`,
  },
  {
    id: "weekly",
    name: "Weekly review",
    icon: "calendar",
    blurb: "Reflect every Sunday",
    title: "Weekly review",
    content: `# Weekly review\n\n## Wins\n- \n\n## What drained me\n- \n\n## Numbers\nWords:   · Focus sessions:   · Games won: \n\n## Next week\n- [ ] \n`,
  },
];
