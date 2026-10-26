import { createElement, Fragment, isValidElement, type ComponentType, type ReactNode } from "react";

// React Native's views as DOM elements, for the screens' tests, which run in happy-dom. A test
// mocks react-native with these and puts its own stand-ins over the parts it watches:
//
//   vi.mock("react-native", async () => ({
//     ...(await import("./react-native.ts")).reactNative,
//     Alert: { alert: (title: string) => scenario.alerts.push(title) },
//   }));
//
// A view keeps its testID and accessibility label, a Pressable is a button pressed by a click, a
// TextInput an input, and a list draws every row, with its header, empty and footer parts.

type Props = { children?: ReactNode; testID?: string; accessibilityLabel?: string };

/** A view: a div with its testID and accessibility label. */
export const box = ({ children, testID, accessibilityLabel }: Props) =>
  createElement("div", { "data-testid": testID, "aria-label": accessibilityLabel }, children);

/** A list's header, footer or empty part, which React Native takes as an element or a component. */
const part = (given: unknown): ReactNode =>
  given === undefined || given === null || isValidElement(given)
    ? (given as ReactNode)
    : createElement(given as ComponentType);

/** A row's key as React Native's lists pick it: the list's own extractor, else the row's key or id. */
const rowKey = <T>(item: T, index: number, keyExtractor?: (item: T, index: number) => string) => {
  if (keyExtractor) return keyExtractor(item, index);
  const row = item as { key?: unknown; id?: unknown } | null;
  return String(row?.key ?? row?.id ?? index);
};

/** A FlatList that draws every row. */
const FlatList = <T>({
  data,
  renderItem,
  keyExtractor,
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  testID,
}: {
  data: readonly T[];
  renderItem: (info: { item: T; index: number }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  ListHeaderComponent?: unknown;
  ListFooterComponent?: unknown;
  ListEmptyComponent?: unknown;
  testID?: string;
}) =>
  createElement(
    "div",
    { "data-testid": testID },
    part(ListHeaderComponent),
    data.length === 0
      ? part(ListEmptyComponent)
      : data.map((item, index) =>
          createElement(
            Fragment,
            { key: rowKey(item, index, keyExtractor) },
            renderItem({ item, index }),
          ),
        ),
    part(ListFooterComponent),
  );

/** A SectionList that draws every section: its header, rows and footer. */
const SectionList = <T, S extends { data: readonly T[] }>({
  sections,
  renderItem,
  keyExtractor,
  renderSectionHeader,
  renderSectionFooter,
  ListHeaderComponent,
  ListFooterComponent,
  ListEmptyComponent,
  testID,
}: {
  sections: readonly S[];
  renderItem: (info: { item: T; index: number; section: S }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  renderSectionHeader?: (info: { section: S }) => ReactNode;
  renderSectionFooter?: (info: { section: S }) => ReactNode;
  ListHeaderComponent?: unknown;
  ListFooterComponent?: unknown;
  ListEmptyComponent?: unknown;
  testID?: string;
}) =>
  createElement(
    "div",
    { "data-testid": testID },
    part(ListHeaderComponent),
    sections.length === 0
      ? part(ListEmptyComponent)
      : sections.map((section, at) =>
          createElement(
            Fragment,
            { key: at },
            renderSectionHeader?.({ section }),
            section.data.map((item, index) =>
              createElement(
                Fragment,
                { key: rowKey(item, index, keyExtractor) },
                renderItem({ item, index, section }),
              ),
            ),
            renderSectionFooter?.({ section }),
          ),
        ),
    part(ListFooterComponent),
  );

/** The react-native module's parts the screens use, quiet where a test doesn't watch them. */
export const reactNative = {
  View: box,
  ScrollView: box,
  Modal: box,
  Text: ({ children }: Props) => createElement("span", null, children),
  Image: () => null,
  Switch: () => null,
  StatusBar: () => null,
  Pressable: ({
    children,
    testID,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    disabled,
    onPress,
  }: Props & {
    accessibilityRole?: string;
    accessibilityState?: { selected?: boolean };
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    createElement(
      "button",
      {
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        "data-role": accessibilityRole,
        "aria-pressed": accessibilityState?.selected,
        disabled,
        onClick: onPress,
      },
      children,
    ),
  TextInput: ({
    testID,
    value,
    onChangeText,
  }: Props & { value?: string; onChangeText?: (value: string) => void }) =>
    createElement("input", {
      "data-testid": testID,
      value,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  FlatList,
  SectionList,
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
  DynamicColorIOS: () => "#000000",
  Keyboard: { dismiss: () => undefined },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Linking: { openURL: async () => undefined },
  Alert: { alert: () => undefined },
  ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  AccessibilityInfo: {
    isReduceTransparencyEnabled: async () => false,
    isReduceMotionEnabled: async () => false,
    addEventListener: () => ({ remove: () => undefined }),
    announceForAccessibility: () => undefined,
    announceForAccessibilityWithOptions: () => undefined,
  },
};
