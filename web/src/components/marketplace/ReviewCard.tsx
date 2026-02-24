import { ProceduralAvatar } from "@/components/avatar/ProceduralAvatar";
import { AddressDisplay } from "@/components/shared/AddressDisplay";
import { Star } from "lucide-react";

interface Props {
  reviewerAddress: string;
  rating: number;
  comment: string;
  createdAt: string;
}

export function ReviewCard({ reviewerAddress, rating, comment, createdAt }: Props) {
  return (
    <div className="border border-border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ProceduralAvatar address={reviewerAddress} size={28} className="shrink-0" />
          <AddressDisplay address={reviewerAddress} />
        </div>
        <div className="flex items-center gap-0.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              className={`h-3.5 w-3.5 ${
                i < rating
                  ? "fill-amber-400 text-amber-400"
                  : "text-gray-600"
              }`}
            />
          ))}
        </div>
      </div>
      {comment && (
        <p className="text-sm text-muted-foreground">{comment}</p>
      )}
      <p className="text-xs text-muted">
        {new Date(createdAt).toLocaleDateString()}
      </p>
    </div>
  );
}
