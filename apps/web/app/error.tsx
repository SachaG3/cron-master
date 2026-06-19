"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-md p-6">
        <p className="text-sm font-medium text-muted-foreground">Erreur</p>
        <h1 className="mt-2 text-2xl font-semibold">Impossible d'afficher la page</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message || "Une erreur inattendue est survenue."}</p>
        <Button type="button" className="mt-5" onClick={reset}>
          Reessayer
        </Button>
      </Card>
    </main>
  );
}
