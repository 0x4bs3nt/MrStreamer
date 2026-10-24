// The one menu look: a rounded surface a step above the black page, holding rows that stay flat
// until the pointer or the keys reach them, then fill with the control radius.

/** Every menu's and popover's surface. Its user adds the size, overflow and text. */
export const menuSurface =
  "rounded-2xl bg-popover p-2 shadow-2xl ring-1 ring-white/12 outline-none";

/** A row of a Base UI menu, filled while highlighted. Its user adds padding and layout. */
export const menuItem = "rounded-lg outline-none data-highlighted:bg-white/10";
