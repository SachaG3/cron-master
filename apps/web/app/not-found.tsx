import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-md p-6">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="mt-2 text-2xl font-semibold">Page introuvable</h1>
        <p className="mt-2 text-sm text-muted-foreground">La page demandee n'existe pas ou a ete deplacee.</p>
        <Button asChild className="mt-5">
          <Link href="/">Retour au dashboard</Link>
        </Button>
      </Card>
    </main>
  );
}
