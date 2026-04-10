import { useGetRecipeStats, getGetRecipeStatsQueryKey } from "@zeroplate/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Target, Leaf, Search, Carrot, Trophy } from "lucide-react";

export function Stats() {
  const { data, isLoading } = useGetRecipeStats({
    query: { queryKey: getGetRecipeStatsQueryKey() }
  });
  const stats = data?.data;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center gap-3 border-b pb-6">
        <div className="w-12 h-12 rounded-xl bg-secondary/10 flex items-center justify-center text-secondary">
          <Target className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground">Your Impact</h1>
          <p className="text-muted-foreground">See how much food you've saved from the landfill.</p>
        </div>
      </div>

      {isLoading || !stats ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-64 rounded-xl md:col-span-2 lg:col-span-3" />
        </div>
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card className="bg-primary/5 border-primary/20 shadow-sm">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-2">
                  <Leaf className="w-6 h-6" />
                </div>
                <div className="text-4xl font-bold text-primary">{stats.wasteReductionScore}</div>
                <div className="text-sm font-medium text-primary/80 uppercase tracking-wider">Waste Reduction Score</div>
              </CardContent>
            </Card>

            <Card className="border-border/60 shadow-sm">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center text-muted-foreground mb-2">
                  <Search className="w-6 h-6" />
                </div>
                <div className="text-4xl font-bold text-foreground">{stats.totalSearches}</div>
                <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Recipe Searches</div>
              </CardContent>
            </Card>

            <Card className="border-border/60 shadow-sm">
              <CardContent className="p-6 flex flex-col items-center text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-secondary/10 flex items-center justify-center text-secondary mb-2">
                  <Carrot className="w-6 h-6" />
                </div>
                <div className="text-4xl font-bold text-foreground">{stats.totalIngredientsUsed}</div>
                <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Ingredients Saved</div>
              </CardContent>
            </Card>
          </div>

          <Card className="border-border/60 shadow-sm overflow-hidden">
            <div className="h-1 w-full bg-gradient-to-r from-secondary to-primary opacity-50" />
            <CardHeader className="pb-4">
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-500" />
                <CardTitle className="text-xl">Most Saved Ingredients</CardTitle>
              </div>
              <CardDescription>The ingredients you frequently rescue from going bad.</CardDescription>
            </CardHeader>
            <CardContent>
              {stats.mostUsedIngredients && stats.mostUsedIngredients.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {stats.mostUsedIngredients.map((ingredient, index) => (
                    <div key={index} className="px-4 py-2 bg-muted rounded-lg text-sm font-medium text-foreground border border-border/50 shadow-sm flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-secondary"></span>
                      {ingredient}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground italic py-4">
                  Keep generating recipes to see your top ingredients here.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
