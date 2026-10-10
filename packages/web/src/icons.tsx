import type { ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (children: ReactNode, props: P, fill = false) => (
  <svg viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {children}
  </svg>
);

export const Book = (p: P) => base(<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M4 19V5.5" /><path d="M9 8h6" /></>, p);
export const Calendar = (p: P) => base(<><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>, p);
export const Cart = (p: P) => base(<><path d="M3 4h2.5l2.2 11h10.6l2-8H6.3" /><circle cx="9.5" cy="19.5" r="1.3" /><circle cx="17" cy="19.5" r="1.3" /></>, p);
export const Plus = (p: P) => base(<path d="M12 5v14M5 12h14" />, p);
export const Minus = (p: P) => base(<path d="M5 12h14" />, p);
export const Dots = (p: P) => base(<><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>, p);
export const Heart = (p: P & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return base(<path d="M12 20.5s-7.5-4.6-9.2-9.3C1.6 7.700 3.700 4.500 7 4.500c2 0 3.400 1.100 5 3 1.600-1.900 3-3 5-3 3.300 0 5.400 3.200 4.200 6.700-1.700 4.700-9.200 9.300-9.200 9.300z" />, rest, !!filled);
};
export const Clock = (p: P) => base(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, p);
export const Flame = (p: P) => base(<path d="M12 3c1 3.500 5 5.500 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .2 1.500 1 2 1.800 2C10.500 8 11 5.500 12 3z" />, p);
export const Snow = (p: P) => base(<path d="M12 2v20M4 7l16 10M20 7 4 17M9 3.500l3 2.500 3-2.500M9 20.500l3-2.500 3 2.500" />, p);
export const Fridge = (p: P) => base(<><rect x="6" y="2.500" width="12" height="19" rx="2.500" /><path d="M6 10h12M9 6v1.500M9 13v3" /></>, p);
export const Search = (p: P) => base(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.500-3.500" /></>, p);
export const Filter = (p: P) => base(<path d="M4 6h16M7 12h10M10 18h4" />, p);
export const ChevL = (p: P) => base(<path d="m15 5-7 7 7 7" />, p);
export const ChevR = (p: P) => base(<path d="m9 5 7 7-7 7" />, p);
export const ChevD = (p: P) => base(<path d="m5 9 7 7 7-7" />, p);
export const Check = (p: P) => base(<path d="m4.500 12.500 5 5L19.500 6.500" strokeWidth="3" />, p);
export const X = (p: P) => base(<path d="M6 6l12 12M18 6 6 18" />, p);
export const Edit = (p: P) => base(<><path d="M4 20h4L19 9a2.800 2.800 0 0 0-4-4L4 16z" /><path d="m13.500 6.500 4 4" /></>, p);
export const Trash = (p: P) => base(<><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>, p);
export const Camera = (p: P) => base(<><path d="M4 8h3l1.500-2.500h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.500" /></>, p);
export const Link = (p: P) => base(<><path d="M10 14a4 4 0 0 0 5.700 0l3-3a4 4 0 0 0-5.700-5.700l-1 1" /><path d="M14 10a4 4 0 0 0-5.700 0l-3 3A4 4 0 0 0 11 18.700l1-1" /></>, p);
export const Image = (p: P) => base(<><rect x="3.500" y="4.500" width="17" height="15" rx="3" /><circle cx="9" cy="10" r="1.800" /><path d="m4 18 5-5 4 4 3-3 4 4" /></>, p);
export const Gear = (p: P) => base(<><circle cx="12" cy="12" r="3" /><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3M5.300 5.300l2.100 2.100M16.600 16.600l2.100 2.100M5.300 18.700l2.100-2.100M16.600 7.400l2.100-2.100" /></>, p);
export const Leaf = (p: P) => base(<path d="M5 19c0-8 4-14 15-14 0 10-5 15-12 15M5 19c2-5 5-8 9-10" />, p);
export const Users = (p: P) => base(<><circle cx="9" cy="8.500" r="3.200" /><path d="M3 20c0-3.500 2.700-6 6-6s6 2.500 6 6" /><path d="M16 5.500a3 3 0 0 1 0 6M18 14.500c2 .8 3 2.700 3 5.500" /></>, p);
export const Refresh = (p: P) => base(<><path d="M20 11a8 8 0 0 0-14-4l-2 2" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14 4l2-2" /><path d="M20 20v-5h-5" /></>, p);
export const Sparkle = (p: P) => base(<path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM19 16l.8 2.200L22 19l-2.200.8L19 22l-.8-2.200L16 19l2.200-.8z" />, p);
export const EyeOff = (p: P) => base(<><path d="M3 3l18 18" /><path d="M10.600 6.100A9 9 0 0 1 12 6c5 0 8.500 4 9.500 6a14 14 0 0 1-3 3.700M6.500 7.500A14 14 0 0 0 2.500 12C3.500 14 7 18 12 18a8.600 8.600 0 0 0 3.500-.7" /><path d="M9.900 9.900a3 3 0 0 0 4.200 4.200" /></>, p);
export const Copy = (p: P) => base(<><rect x="8" y="8" width="12" height="12" rx="2.500" /><path d="M16 8V6a2.500 2.500 0 0 0-2.500-2.500H6A2.500 2.500 0 0 0 3.500 6v7.500A2.500 2.500 0 0 0 6 16h2" /></>, p);
export const History = (p: P) => base(<><path d="M3.500 12a8.500 8.500 0 1 0 2.600-6.100L3.500 8.500" /><path d="M3.500 4v4.500H8M12 7.500V12l3 2" /></>, p);
export const Star = (p: P & { filled?: boolean }) => {
  const { filled, ...rest } = p;
  return base(<path d="m12 3 2.800 5.700 6.200.9-4.500 4.400 1.100 6.200L12 17.200 6.400 20.200l1.100-6.200L3 9.600l6.200-.9z" />, rest, !!filled);
};
export const Utensils = (p: P) => base(<path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 21V3c-2.500 1-4 4-4 8h4" />, p);
export const Database = (p: P) => base(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.700 3.600 3 8 3s8-1.300 8-3V6M4 12v6c0 1.700 3.600 3 8 3s8-1.300 8-3v-6" /></>, p);
export const Info = (p: P) => base(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.1" /></>, p);
export const Alert = (p: P) => base(<><path d="M12 3.500 2.500 20h19z" /><path d="M12 10v4.500M12 17.500v.1" /></>, p);
export const Upload = (p: P) => base(<><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v4h16v-4" /></>, p);
export const Eye = (p: P) => base(<><path d="M2.500 12C4 8.500 7.500 6 12 6s8 2.500 9.500 6c-1.500 3.500-5 6-9.500 6s-8-2.500-9.500-6z" /><circle cx="12" cy="12" r="3" /></>, p);
export const Share = (p: P) => base(<><circle cx="6" cy="12" r="2.500" /><circle cx="18" cy="6" r="2.500" /><circle cx="18" cy="18" r="2.500" /><path d="m8.200 10.800 7.600-3.600M8.200 13.200l7.600 3.600" /></>, p);
