import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text, type SelectItem } from "@earendil-works/pi-tui";

export function wrapSelectionIndex(index: number, direction: -1 | 1, count: number): number {
  if (count <= 0) return 0;
  return (index + direction + count) % count;
}

export async function searchableSelect(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
  if (!options.length) return undefined;
  if (ctx.mode !== "tui") return ctx.ui.select(title, options);

  const items: SelectItem[] = options.map((value) => ({ value, label: value }));
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const container = new Container();
    const searchInput = new Input({ placeholder: "Type to fuzzy search…" });
    searchInput.focused = true;
    let filteredItems = items;
    let selectedIndex = 0;
    let selectList: SelectList | undefined;

    const updateList = () => {
      const query = searchInput.getValue();
      filteredItems = query ? fuzzyFilter(items, query, (item) => item.label) : items;
      selectedIndex = 0;
      renderContent();
      tui.requestRender();
    };

    const renderContent = () => {
      container.clear();
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));
      container.addChild(searchInput);
      container.addChild(new Spacer(1));
      if (filteredItems.length) {
        selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        selectList.setSelectedIndex(selectedIndex);
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(undefined);
        container.addChild(selectList);
      } else {
        selectList = undefined;
        container.addChild(new Text(theme.fg("muted", "No matching choices")));
      }
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate (wrap) · type to fuzzy search · enter select · esc cancel")));
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    };

    renderContent();
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.up")) {
          if (filteredItems.length) {
            selectedIndex = wrapSelectionIndex(selectedIndex, -1, filteredItems.length);
            selectList?.setSelectedIndex(selectedIndex);
          }
        } else if (keybindings.matches(data, "tui.select.down")) {
          if (filteredItems.length) {
            selectedIndex = wrapSelectionIndex(selectedIndex, 1, filteredItems.length);
            selectList?.setSelectedIndex(selectedIndex);
          }
        } else if (keybindings.matches(data, "tui.select.confirm")) {
          const selected = filteredItems[selectedIndex];
          if (selected) done(selected.value);
        } else if (keybindings.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else {
          searchInput.handleInput(data);
          updateList();
          return;
        }
        tui.requestRender();
      },
    };
  });
}
