import { Suspense } from "react";
import { ShareView } from "./ShareView";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-slate-500">Loading…</div>}>
      <ShareView />
    </Suspense>
  );
}
