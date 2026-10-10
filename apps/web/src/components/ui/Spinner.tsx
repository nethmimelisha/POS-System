import { Loader2 } from "lucide-react";

export function Spinner({ className = "size-5" }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} aria-label="Loading" role="status" />;
}
