/**
 * /show-usage 交互式选择菜单。
 *
 * 两级导航（单次 ctx.ui.custom 内完成）：
 *   一级：选择 provider，或 all / off / status / Cancel
 *   二级（选中 provider 后）：逐套餐切换（标注当前 on/off），或 Show all / Hide all / Back
 *
 * 菜单只负责收集选择，返回一条“指令字符串”交给命令 handler 执行
 * （指令与命令行参数同构：如 "ark"、"ark coding"、"all"、"off"、"status"）。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

import type { ProviderFileConfig } from "./config.ts";

/** theme 最小接口（避免依赖 pi 内部 Theme 类型） */
interface MenuTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

type PlanStateQuery = (shortName: string, planType: string) => boolean;

/** 打开菜单，返回指令字符串；用户取消返回 undefined */
export function showUsageMenu(
  ctx: ExtensionContext,
  providers: ProviderFileConfig[],
  isOn: PlanStateQuery,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _keybindings, done) =>
      new UsageMenu(providers, isOn, theme as unknown as MenuTheme, done, () =>
        tui.requestRender(),
      ),
    // 不用 overlay：与 /model 等原生选择器一致，菜单替换编辑器区域显示（位置合理、自动获得焦点）
  );
}

class UsageMenu extends Container {
  private list: SelectList;
  private provider?: ProviderFileConfig;

  constructor(
    private providers: ProviderFileConfig[],
    private isOn: PlanStateQuery,
    private theme: MenuTheme,
    private done: (arg: string | undefined) => void,
    private requestRender: () => void,
  ) {
    super();
    this.showProviders();
  }

  /** 一级：provider / all / off / status / cancel */
  private showProviders(): void {
    this.provider = undefined;
    const items: SelectItem[] = [
      ...this.providers.map((f) => ({
        value: f.shortName,
        label: f.shortName,
        description: `${this.theme.fg("muted", "")}${f.accounts.map((a) => a.label ?? a.planType).join(", ")}`,
      })),
      { value: "all", label: "all", description: "Show everything" },
      { value: "off", label: "off", description: "Hide everything" },
      { value: "status", label: "status", description: "Show current on/off state" },
      { value: "__cancel", label: "Cancel", description: "Close menu, do nothing" },
    ];
    this.rebuild("Select provider", items, (item) => this.onProviderSelect(item));
  }

  /** 二级：某 provider 的套餐，含 show all / hide all / back */
  private showPlans(provider: ProviderFileConfig): void {
    const items: SelectItem[] = provider.accounts.map((a) => {
      const plan = String(a.planType).toLowerCase();
      const state = this.isOn(provider.shortName, plan) ? "on" : "off";
      return {
        value: `${provider.shortName} ${plan}`,
        label: `${plan} (${state})`,
        description: `${a.label ?? ""} ${state === "on" ? "●" : "○"} click to toggle`,
      };
    });
    items.push(
      { value: `${provider.shortName} on`, label: "Show all plans", description: "" },
      { value: `${provider.shortName} off`, label: "Hide all plans", description: "" },
      { value: "__back", label: "Back", description: "Back to provider list" },
    );
    this.rebuild(`Plans: ${provider.shortName}`, items, (item) => this.onPlanSelect(item));
  }

  private rebuild(
    title: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
  ): void {
    this.clear();
    this.addChild(new Text(this.theme.fg("accent", this.theme.bold(title)), 0, 0));
    this.addChild(new Text("", 0, 0));
    this.list = new SelectList(items, Math.min(items.length + 2, 12), {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", this.theme.bold(s)),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("dim", s),
    });
    this.list.onSelect = onSelect;
    this.list.onCancel = () => {
      if (this.provider) this.showProviders();
      else this.done(undefined);
    };
    this.addChild(this.list);
    this.addChild(new Text(this.theme.fg("dim", "↑↓ select · enter confirm · esc cancel"), 0, 0));
    this.requestRender();
  }

  private onProviderSelect(item: SelectItem): void {
    switch (item.value) {
      case "__cancel":
        this.done(undefined);
        return;
      case "all":
      case "off":
      case "status":
        this.done(item.value);
        return;
      default: {
        const file = this.providers.find((f) => f.shortName === item.value);
        if (!file) return;
        this.provider = file;
        this.showPlans(file);
      }
    }
  }

  private onPlanSelect(item: SelectItem): void {
    if (item.value === "__back") {
      this.showProviders();
      return;
    }
    this.done(item.value);
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
    this.requestRender();
  }
}
