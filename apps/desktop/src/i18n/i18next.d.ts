import "i18next";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof import("./locales/en/common.json");
      system: typeof import("./locales/en/system.json");
      ui: typeof import("./locales/en/ui.json");
      layout: typeof import("./locales/en/layout.json");
      settings: typeof import("./locales/en/settings.json");
      agents: typeof import("./locales/en/agents.json");
      chat: typeof import("./locales/en/chat.json");
      vault: typeof import("./locales/en/vault.json");
      license: typeof import("./locales/en/license.json");
      tasks: typeof import("./locales/en/tasks.json");
      humanTasks: typeof import("./locales/en/humanTasks.json");
      inbox: typeof import("./locales/en/inbox.json");
      attention: typeof import("./locales/en/attention.json");
      mods: typeof import("./locales/en/mods.json");
      integrations: typeof import("./locales/en/integrations.json");
      browser: typeof import("./locales/en/browser.json");
      files: typeof import("./locales/en/files.json");
      vms: typeof import("./locales/en/vms.json");
      computer: typeof import("./locales/en/computer.json");
      android: typeof import("./locales/en/android.json");
      ssh: typeof import("./locales/en/ssh.json");
      onboarding: typeof import("./locales/en/onboarding.json");
      workspaces: typeof import("./locales/en/workspaces.json");
      automations: typeof import("./locales/en/automations.json");
      projects: typeof import("./locales/en/projects.json");
      runs: typeof import("./locales/en/runs.json");
      runners: typeof import("./locales/en/runners.json");
      activity: typeof import("./locales/en/activity.json");
      aicss: typeof import("./locales/en/aicss.json");
      messaging: typeof import("./locales/en/messaging.json");
      artifacts: typeof import("./locales/en/artifacts.json");
      calls: typeof import("./locales/en/calls.json");
      permissions: typeof import("./locales/en/permissions.json");
      instructions: typeof import("./locales/en/instructions.json");
      devices: typeof import("./locales/en/devices.json");
      auth: typeof import("./locales/en/auth.json");
      templates: typeof import("./locales/en/templates.json");
    };
  }
}
