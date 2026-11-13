import { NewsDashboard } from "@/components/NewsDashboard";

export const metadata = { title: "News Intelligence · FPL Intelligence" };

export default function NewsPage() {
  return (
    <main className="mx-auto max-w-7xl px-3 py-4 sm:px-6">
      <NewsDashboard />
    </main>
  );
}
