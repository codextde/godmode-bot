/**
 * Ready-made agent templates offered in the "New agent" dialog (GET /api/agent-templates), one file per department.
 * Each department has an all-in-one agent that covers every job in it (`covers`), a lead and its specialists, so a
 * business can start with one agent per department and hire specialists as the work grows. Each template comes with a
 * look and a personality that hint at its job.
 */
import { AGENT_TEMPLATE_CATEGORIES, type AgentTemplate } from "@godmode/shared";
import { CUSTOMER } from "./customer";
import { DATA } from "./data";
import { ECOMMERCE } from "./ecommerce";
import { ENGINEERING } from "./engineering";
import { FINANCE } from "./finance";
import { LEADERSHIP } from "./leadership";
import { LEGAL } from "./legal";
import { MARKETING } from "./marketing";
import { OPERATIONS } from "./operations";
import { PEOPLE } from "./people";
import { PRODUCT } from "./product";
import { SALES } from "./sales";

export { allInOneInstructions, leadInstructions } from "./instructions";

const ALL = [...LEADERSHIP, ...FINANCE, ...LEGAL, ...PEOPLE, ...MARKETING, ...SALES, ...CUSTOMER, ...ECOMMERCE, ...PRODUCT, ...ENGINEERING, ...DATA, ...OPERATIONS];

/** In department order, as the dialog shows them. */
export const AGENT_TEMPLATES: AgentTemplate[] = AGENT_TEMPLATE_CATEGORIES.flatMap((c) => ALL.filter((t) => t.category === c));
