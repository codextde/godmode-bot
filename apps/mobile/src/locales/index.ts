import en_common from "./en/common.json";
import en_system from "./en/system.json";
import en_components from "./en/components.json";
import en_tabs from "./en/tabs.json";
import en_settings from "./en/settings.json";
import en_onboarding from "./en/onboarding.json";
import en_chat from "./en/chat.json";
import en_agents from "./en/agents.json";
import en_automations from "./en/automations.json";
import en_memory from "./en/memory.json";
import en_dreams from "./en/dreams.json";
import en_tasks from "./en/tasks.json";
import en_humanTasks from "./en/humanTasks.json";
import en_inbox from "./en/inbox.json";
import en_runs from "./en/runs.json";
import en_calls from "./en/calls.json";
import de_common from "./de/common.json";
import de_system from "./de/system.json";
import de_components from "./de/components.json";
import de_tabs from "./de/tabs.json";
import de_settings from "./de/settings.json";
import de_onboarding from "./de/onboarding.json";
import de_chat from "./de/chat.json";
import de_agents from "./de/agents.json";
import de_automations from "./de/automations.json";
import de_memory from "./de/memory.json";
import de_dreams from "./de/dreams.json";
import de_tasks from "./de/tasks.json";
import de_humanTasks from "./de/humanTasks.json";
import de_inbox from "./de/inbox.json";
import de_runs from "./de/runs.json";
import de_calls from "./de/calls.json";

export const resources = {
  en: { common: en_common, system: en_system, components: en_components, tabs: en_tabs, settings: en_settings, onboarding: en_onboarding, chat: en_chat, agents: en_agents, automations: en_automations, memory: en_memory, dreams: en_dreams, tasks: en_tasks, humanTasks: en_humanTasks, inbox: en_inbox, runs: en_runs, calls: en_calls },
  de: { common: de_common, system: de_system, components: de_components, tabs: de_tabs, settings: de_settings, onboarding: de_onboarding, chat: de_chat, agents: de_agents, automations: de_automations, memory: de_memory, dreams: de_dreams, tasks: de_tasks, humanTasks: de_humanTasks, inbox: de_inbox, runs: de_runs, calls: de_calls },
} as const;

export const NAMESPACES = ["common", "system", "components", "tabs", "settings", "onboarding", "chat", "agents", "automations", "memory", "dreams", "tasks", "humanTasks", "inbox", "runs", "calls"] as const;
