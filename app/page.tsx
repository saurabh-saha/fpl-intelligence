import { redirect } from "next/navigation";
import { getDataset } from "@/lib/fpl/client";
import { nextGameweek } from "@/lib/fpl/normalizer";

export const dynamic = "force-dynamic";

/** Land straight on the next gameweek's recommended squad. */
export default async function Home() {
  const ds = await getDataset();
  redirect(`/team-builder?gw=${nextGameweek(ds.events).id}`);
}
