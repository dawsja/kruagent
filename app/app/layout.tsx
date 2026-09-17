import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Board",
  description: "Drop a card. An agent proposes changes. Approve the pull request.",
};

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return children;
}
