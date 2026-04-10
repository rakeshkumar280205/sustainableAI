import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Loader2, Upload, Sparkles, Clock, ChefHat, AlertCircle, CheckCircle2,
  ImageIcon, Globe, Leaf, RefreshCw, Lightbulb, Star, Info, Zap
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useRecipeGenerator, CUISINE_OPTIONS } from "@/hooks/use-recipe-generator";
import { getEfficiencyPct } from "@/utils/sustainability";
import { countIngredients } from "@/utils/ingredients";

const SAMPLE_INGREDIENTS = "tomato, onion, garlic, olive oil, basil, feta cheese";

export function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const {
    ingredients, setIngredients,
    cuisine, setCuisine,
    detectedApproximate,
    data, isPending, isDetecting, isGenerating,
    handleSubmit, runGenerate,
    handleImageChange, handleTryAnotherCuisine, handleReset,
    usedCount, totalMissing, savedLow, savedHigh, smartInsight, bestRecipeIndex,
  } = useRecipeGenerator();

  const ingredientCount = countIngredients(ingredients);

  const handleTryDemo = () => {
    setIngredients(SAMPLE_INGREDIENTS);
    setCuisine("Italian");
  };

  return (
    <div className="space-y-12 animate-in fade-in duration-500 pb-20">

      {/* Hero */}
      <section className="text-center space-y-4 max-w-2xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold text-foreground">
          What's in your kitchen?
        </h1>
        <p className="text-lg text-muted-foreground">
          Tell ZeroPlate Chef what you have — or upload a fridge photo. We'll generate
          cuisine-specific recipes so nothing goes to waste.
        </p>
      </section>

      {/* Input card */}
      <section className="max-w-2xl mx-auto relative z-10">
        <Card className="shadow-lg border-primary/20 overflow-hidden">
          <div className="h-2 bg-gradient-to-r from-primary to-secondary w-full" />
          <CardContent className="p-6">
            <form onSubmit={handleSubmit} className="space-y-6">

              {/* Ingredients */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ingredients" className="text-base font-medium">
                    Your ingredients
                  </Label>
                  <div className="flex gap-2">
                    {ingredients.trim() && (
                      <button
                        type="button"
                        onClick={handleReset}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                      >
                        Clear
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleTryDemo}
                      className="text-xs text-primary hover:text-primary/80 transition-colors underline underline-offset-2 font-semibold flex items-center gap-1"
                    >
                      <Zap className="w-3 h-3" />
                      Try demo
                    </button>
                  </div>
                </div>
                <Textarea
                  id="ingredients"
                  data-testid="input-ingredients"
                  placeholder="e.g. 2 tomatoes, half an onion, wilted spinach, feta cheese"
                  className="min-h-[120px] resize-none text-base p-4 bg-muted/50 border-muted-foreground/20 focus-visible:ring-primary"
                  value={ingredients}
                  onChange={(e) => setIngredients(e.target.value)}
                />
                <div className="flex items-center justify-between min-h-[1.25rem]">
                  {detectedApproximate ? (
                    <p className="flex items-center gap-1.5 text-xs text-amber-600">
                      <ImageIcon className="w-3.5 h-3.5 shrink-0" />
                      Detected ingredients (approximate — editable)
                    </p>
                  ) : (
                    <span />
                  )}
                  {ingredientCount > 0 && ingredientCount < 3 && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Info className="w-3.5 h-3.5 shrink-0" />
                      Add more ingredients for better results
                    </p>
                  )}
                </div>
              </div>

              {/* Cuisine */}
              <div className="space-y-2">
                <Label htmlFor="cuisine" className="text-base font-medium flex items-center gap-1.5">
                  <Globe className="w-4 h-4" />
                  Cuisine type
                </Label>
                <Select value={cuisine} onValueChange={setCuisine}>
                  <SelectTrigger
                    id="cuisine"
                    data-testid="select-cuisine"
                    className="bg-muted/50 border-muted-foreground/20 focus:ring-primary"
                  >
                    <SelectValue placeholder="Any cuisine" />
                  </SelectTrigger>
                  <SelectContent>
                    {CUISINE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row items-center gap-4 justify-between">
                <div>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleImageChange}
                    data-testid="input-image-upload"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full sm:w-auto gap-2 border-dashed border-2 hover:bg-muted/50"
                    disabled={isPending}
                    data-testid="button-upload-photo"
                  >
                    {isDetecting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4" />
                        Upload Fridge Photo
                      </>
                    )}
                  </Button>
                </div>

                <Button
                  type="submit"
                  disabled={!ingredients.trim() || isPending}
                  className="w-full sm:w-auto gap-2 shadow-md hover:shadow-lg transition-all"
                  size="lg"
                  data-testid="button-find-recipes"
                >
                  {isPending ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Generating...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-5 h-5" />
                      <span>Generate Recipes</span>
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </section>

      {/* Loading state */}
      {isPending && !data && (
        <section className="max-w-4xl mx-auto">
          <Card className="bg-muted/50 border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <div className="text-center space-y-1">
                <p className="font-medium text-foreground">
                  {isDetecting ? "Processing your image..." : "Generating your recipes..."}
                </p>
                <p className="text-sm text-muted-foreground">
                  {isDetecting ? "Extracting ingredients from your photo" : "This usually takes a few seconds"}
                </p>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {/* Results */}
      {data && (
        <section className="space-y-8 max-w-4xl mx-auto animate-in slide-in-from-bottom-8 duration-700 fade-in">

          {/* Fallback notice */}
          {data.isFallback && (
            <Alert className="bg-amber-50/80 border-amber-300 dark:bg-amber-950/30">
              <AlertCircle className="w-5 h-5 !text-amber-600" />
              <AlertTitle className="text-amber-800 font-semibold">Using smart fallback recipes</AlertTitle>
              <AlertDescription className="text-amber-700">
                AI is taking longer than usual. These curated recipes are cuisine-specific and fully structured.
              </AlertDescription>
            </Alert>
          )}

          {/* Cuisine + ingredients row */}
          <div className="flex flex-wrap items-center gap-3">
            {data.cuisine && (
              <div className="flex items-center gap-2 bg-muted rounded-full px-4 py-1.5">
                <Globe className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold text-foreground">{data.cuisine}</span>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {data.ingredientsUsed.slice(0, 5).map((ing, i) => (
                <Badge
                  key={i}
                  variant="secondary"
                  className="bg-primary/10 text-primary border-primary/20 capitalize"
                  data-testid={`badge-ingredient-${i}`}
                >
                  {ing}
                </Badge>
              ))}
              {data.ingredientsUsed.length > 5 && (
                <Badge variant="secondary" className="bg-muted text-muted-foreground">
                  +{data.ingredientsUsed.length - 5} more
                </Badge>
              )}
            </div>
          </div>

          {/* Sustainability impact */}
          <Alert className="bg-green-50/80 border-green-300 dark:bg-green-950/30">
            <Leaf className="w-5 h-5 !text-green-600" />
            <AlertTitle className="text-green-800 dark:text-green-400 font-semibold">
              Sustainability Impact
            </AlertTitle>
            <AlertDescription className="text-green-700 dark:text-green-500">
              You used <strong>{usedCount} ingredient{usedCount !== 1 ? "s" : ""}</strong> and
              saved approx. <strong>{savedLow}–{savedHigh}g</strong> of food from being wasted.
            </AlertDescription>
          </Alert>

          {/* Smart insight */}
          <div className="flex items-start gap-3 px-4 py-3 bg-muted/50 rounded-xl border border-border/50">
            <Lightbulb className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground leading-relaxed">{smartInsight}</p>
          </div>

          {/* Recipe cards */}
          <div className="space-y-4">
            <h2 className="text-3xl font-serif font-bold border-b pb-4">Inspired Meals</h2>
            {data.recipes.length === 0 ? (
              <Card className="bg-muted/50">
                <CardContent className="flex flex-col items-center justify-center py-12 gap-2">
                  <ChefHat className="w-8 h-8 text-muted-foreground" />
                  <p className="text-muted-foreground">No recipes found with those ingredients.</p>
                  <p className="text-sm text-muted-foreground">Try different ingredients or select a specific cuisine.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {data.recipes.map((recipe, index) => {
                  const usedHere = recipe.used?.length ?? 0;
                  const efficiencyPct = getEfficiencyPct(usedHere, usedCount);
                  const isBest = index === bestRecipeIndex && usedHere > 0;

                  return (
                    <Card
                      key={index}
                      className={`flex flex-col h-full overflow-hidden transition-shadow duration-300 border-border/60 hover:shadow-md ${isBest ? "ring-2 ring-green-400/60 shadow-sm" : ""
                        }`}
                      data-testid={`card-recipe-${index}`}
                    >
                      <CardHeader className="bg-muted/30 pb-4">
                        <div className="flex justify-between items-start gap-3">
                          <CardTitle className="font-serif text-xl leading-tight">
                            {recipe.name}
                          </CardTitle>
                          <div className="flex flex-col items-end gap-1.5 shrink-0">
                            <Badge variant="outline" className="bg-background whitespace-nowrap text-xs">
                              {recipe.difficulty}
                            </Badge>
                            {isBest && (
                              <Badge className="bg-green-100 text-green-800 border-green-300 whitespace-nowrap text-xs gap-1 dark:bg-green-900/40 dark:text-green-300">
                                <Star className="w-3 h-3" />
                                Most efficient
                              </Badge>
                            )}
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {recipe.description}
                        </p>
                      </CardHeader>

                      <CardContent className="pt-4 flex-1 space-y-5">

                        {/* Meta + efficiency bar */}
                        <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-4 h-4" />
                            <span>{recipe.cookTime}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <ChefHat className="w-4 h-4" />
                            <span>{recipe.difficulty}</span>
                          </div>
                          {efficiencyPct > 0 && (
                            <div className="flex items-center gap-1.5 ml-auto">
                              <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-green-500 transition-all"
                                  style={{ width: `${efficiencyPct}%` }}
                                />
                              </div>
                              <span className="text-xs font-medium text-green-700 dark:text-green-400">
                                {efficiencyPct}% match
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Ingredients used */}
                        {recipe.used && recipe.used.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                              <span className="text-xs font-semibold uppercase tracking-wider text-green-700 dark:text-green-500">
                                Using from your kitchen
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {recipe.used.map((item, i) => (
                                <Badge
                                  key={i}
                                  className="bg-green-100 text-green-800 border-green-300 capitalize text-xs dark:bg-green-900/40 dark:text-green-300"
                                  data-testid={`badge-used-${index}-${i}`}
                                >
                                  {item}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Missing ingredients */}
                        {recipe.missing && recipe.missing.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5">
                              <AlertCircle className="w-3.5 h-3.5 text-amber-600" />
                              <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-500">
                                You'll also need
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {recipe.missing.map((item, i) => (
                                <Badge
                                  key={i}
                                  className="bg-amber-100 text-amber-800 border-amber-300 capitalize text-xs dark:bg-amber-900/40 dark:text-amber-300"
                                  data-testid={`badge-missing-${index}-${i}`}
                                >
                                  {item}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Instructions */}
                        <div className="space-y-2">
                          <h4 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
                            Instructions
                          </h4>
                          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground/80">
                            {recipe.instructions}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={runGenerate}
              disabled={isPending}
              className="gap-2"
              data-testid="button-regenerate"
            >
              {isGenerating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Regenerate
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleTryAnotherCuisine}
              disabled={isPending}
              className="gap-2"
              data-testid="button-try-cuisine"
            >
              <Globe className="w-4 h-4" />
              Try another cuisine
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="gap-2 text-muted-foreground hover:text-foreground"
              data-testid="button-edit-ingredients"
            >
              <ImageIcon className="w-4 h-4" />
              Edit ingredients
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
