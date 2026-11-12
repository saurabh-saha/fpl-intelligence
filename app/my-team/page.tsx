import { Suspense } from "react";
import { MyTeam } from "./MyTeam";

export default function Page() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-slate-500">Loading…</div>}>
      <MyTeam />
    </Suspense>
  );
}
