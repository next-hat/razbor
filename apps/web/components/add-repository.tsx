import Link from "next/link.js";
import { Plus } from "lucide-react";

import { buttonVariants } from "@web/components/ui/button.js";

/** Opens the dedicated connection wizard without retaining credentials on the list page. */
export function AddRepository() {
  return (
    <Link href="/repos/new" className={buttonVariants()}>
      <Plus data-icon="inline-start" />
      Connect repository
    </Link>
  );
}
