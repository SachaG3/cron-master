"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AuthCredentials = {
  email: string;
  password: string;
};

type AuthPanelProps = {
  error: string;
  loading: boolean;
  needsSetup: boolean;
  onSubmit: (credentials: AuthCredentials) => Promise<void>;
};

export function AuthPanel({ error, loading, needsSetup, onSubmit }: AuthPanelProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const title = needsSetup ? "Créer le compte admin" : "Connexion";
  const description = needsSetup ? "Ce premier compte protege l'interface d'administration." : "Connecte-toi pour gerer les jobs et les alertes.";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");

    if (needsSetup && password !== passwordConfirm) {
      setLocalError("Les deux mots de passe ne correspondent pas");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({ email: email.trim(), password });
      setPassword("");
      setPasswordConfirm("");
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4">
        <Card className="w-full max-w-sm p-5">
          <p className="text-sm font-medium">Chargement de la session...</p>
        </Card>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-5">
        <div className="mb-5">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {(localError || error) && <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{localError || error}</p>}
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor="auth-email">Email</Label>
            <Input id="auth-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={submitting} required />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="auth-password">Mot de passe</Label>
            <Input
              id="auth-password"
              type="password"
              minLength={8}
              maxLength={256}
              autoComplete={needsSetup ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />
          </div>
          {needsSetup && (
            <div className="grid gap-1">
              <Label htmlFor="auth-password-confirm">Confirmer le mot de passe</Label>
              <Input
                id="auth-password-confirm"
                type="password"
                minLength={8}
                maxLength={256}
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(event) => setPasswordConfirm(event.target.value)}
                disabled={submitting}
                required
              />
            </div>
          )}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Envoi..." : needsSetup ? "Créer le compte" : "Se connecter"}
          </Button>
        </form>
      </Card>
    </main>
  );
}
