import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetRecipeHistory,
  useDeleteRecipeHistory,
  getGetRecipeHistoryQueryKey,
  getGetRecipeStatsQueryKey,
} from "@zeroplate/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { format } from "date-fns";
import { Utensils, History as HistoryIcon, Calendar, Globe, Trash2, Loader2 } from "lucide-react";

export function History() {
  const queryClient = useQueryClient();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data, isLoading } = useGetRecipeHistory({
    query: { queryKey: getGetRecipeHistoryQueryKey() },
  });
  const history = data?.data?.history ?? [];

  const deleteMutation = useDeleteRecipeHistory({
    mutation: {
      onSuccess: () => {
        // Invalidate both history and stats so Impact Stats updates immediately
        queryClient.invalidateQueries({ queryKey: getGetRecipeHistoryQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetRecipeStatsQueryKey() });
        setDeletingId(null);
      },
      onError: () => {
        setDeletingId(null);
      },
    },
  });

  const handleDelete = (id: string) => {
    setDeletingId(id);
    deleteMutation.mutate({ id });
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center gap-3 border-b pb-6">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
          <HistoryIcon className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Past Creations</h1>
          <p className="text-muted-foreground">Your history of saved meals and ingredients.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : history.length > 0 ? (
        <div className="grid gap-4">
          {history.map((item) => {
            const isDeleting = deletingId === item.id;
            return (
              <Card
                key={item.id}
                className={`overflow-hidden border-border/60 transition-all ${isDeleting ? "opacity-50 pointer-events-none" : "hover:border-primary/30"
                  }`}
                data-testid={`card-history-${item.id}`}
              >
                <CardContent className="p-6">
                  <div className="flex flex-col md:flex-row gap-4 justify-between md:items-center">

                    {/* Left: date, cuisine, ingredients */}
                    <div className="space-y-3 flex-1 min-w-0">
                      <div className="flex items-center gap-4 flex-wrap">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Calendar className="w-4 h-4 shrink-0" />
                          <span>{format(new Date(item.createdAt), "MMM d, yyyy 'at' h:mm a")}</span>
                        </div>
                        {item.cuisine && (
                          <div className="flex items-center gap-1.5 text-sm text-primary">
                            <Globe className="w-3.5 h-3.5" />
                            <span className="font-medium">{item.cuisine}</span>
                          </div>
                        )}
                      </div>
                      <div className="space-y-1">
                        <h4 className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                          Ingredients Used
                        </h4>
                        <p className="text-base text-foreground leading-relaxed truncate">
                          {item.ingredients}
                        </p>
                      </div>
                    </div>

                    {/* Right: recipe count, missing badge, delete */}
                    <div className="flex items-center gap-3 md:flex-col md:items-end shrink-0">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 bg-primary/5 text-primary px-3 py-1.5 rounded-lg">
                          <Utensils className="w-4 h-4" />
                          <span className="font-medium text-sm">{item.recipeCount} Recipes</span>
                        </div>
                        {item.missingCount > 0 && (
                          <Badge
                            variant="secondary"
                            className="bg-amber-100 text-amber-700 border-amber-200"
                          >
                            {item.missingCount} Missing
                          </Badge>
                        )}
                      </div>

                      {/* Delete button with confirmation dialog */}
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5"
                            disabled={isDeleting}
                            data-testid={`button-delete-${item.id}`}
                          >
                            {isDeleting ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                            <span className="text-xs">Delete</span>
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently remove this history entry and update your
                              Impact Stats. This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDelete(item.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-20 bg-muted/30 rounded-2xl border border-dashed border-border">
          <Utensils className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
          <h3 className="text-xl font-serif font-semibold text-foreground mb-2">No history yet</h3>
          <p className="text-muted-foreground">When you generate recipes, they'll appear here.</p>
        </div>
      )}
    </div>
  );
}
