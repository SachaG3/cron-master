import { Card } from "@/components/ui/card";

type MetricCardProps = {
  label: string;
  value: string | number;
};

export function MetricCard({ label, value }: MetricCardProps) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
    </Card>
  );
}
