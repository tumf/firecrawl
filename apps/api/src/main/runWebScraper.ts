import { Job } from "bull";
import {
  CrawlResult,
  WebScraperOptions,
  RunWebScraperParams,
  RunWebScraperResult,
} from "../types";
import { WebScraperDataProvider } from "../scraper/WebScraper";
import { DocumentUrl, Progress } from "../lib/entities";
import { billTeam } from "../services/billing/credit_billing";
import { Document } from "../lib/entities";
import { supabase_service } from "../services/supabase";

export async function startWebScraperPipeline({
  job,
}: {
  job: Job<WebScraperOptions>;
}) {
  let partialDocs: Document[] = [];
  return (await runWebScraper({
    url: job.data.url,
    mode: job.data.mode,
    crawlerOptions: job.data.crawlerOptions,
    pageOptions: job.data.pageOptions,
    inProgress: (progress) => {
      if (progress.currentDocument) {
        partialDocs.push(progress.currentDocument);
        if (partialDocs.length > 50) {
          partialDocs = partialDocs.slice(-50);
        }
        job.progress({ ...progress, partialDocs: partialDocs });
      }
    },
    onSuccess: (result) => {
      saveJob(job, result);
    },
    onError: (error) => {
      job.moveToFailed(error);
    },
    team_id: job.data.team_id,
    bull_job_id: job.id.toString(),
  })) as { success: boolean; message: string; docs: Document[] };
}
export async function runWebScraper({
  url,
  mode,
  crawlerOptions,
  pageOptions,
  inProgress,
  onSuccess,
  onError,
  team_id,
  bull_job_id,
}: RunWebScraperParams): Promise<RunWebScraperResult> {
  try {
    const provider = new WebScraperDataProvider();
    if (mode === "crawl") {
      await provider.setOptions({
        mode: mode,
        urls: [url],
        crawlerOptions: crawlerOptions,
        pageOptions: pageOptions,
        bullJobId: bull_job_id,
      });
    } else {
      await provider.setOptions({
        mode: mode,
        urls: url.split(","),
        crawlerOptions: crawlerOptions,
        pageOptions: pageOptions,
      });
    }
    const docs = (await provider.getDocuments(false, (progress: Progress) => {
      inProgress(progress);
    })) as Document[];

    if (docs.length === 0) {
      return {
        success: true,
        message: "No pages found",
        docs: [],
      };
    }

    // remove docs with empty content
    const filteredDocs = crawlerOptions.returnOnlyUrls
      ? docs.map((doc) => {
          if (doc.metadata.sourceURL) {
            return { url: doc.metadata.sourceURL };
          }
        })
      : docs.filter((doc) => doc.content.trim().length > 0);

    const billingResult = await billTeam(team_id, filteredDocs.length);

    if (!billingResult.success) {
      // throw new Error("Failed to bill team, no subscription was found");
      return {
        success: false,
        message: "Failed to bill team, no subscription was found",
        docs: [],
      };
    }

    // This is where the returnvalue from the job is set
    onSuccess(filteredDocs);

    // this return doesn't matter too much for the job completion result
    return { success: true, message: "", docs: filteredDocs };
  } catch (error) {
    console.error("Error running web scraper", error);
    onError(error);
    return { success: false, message: error.message, docs: [] };
  }
}

const saveJob = async (job: Job, result: any) => {
  try {
    if (process.env.USE_DB_AUTHENTICATION === "true") {
      const { data, error } = await supabase_service
        .from("firecrawl_jobs")
        .update({ docs: result })
        .eq("job_id", job.id);

      if (error) throw new Error(error.message);
      try {
        await job.moveToCompleted(null);
      } catch (error) {
        // I think the job won't exist here anymore
      }
    } else {
      try {
        await job.moveToCompleted(result);
      } catch (error) {
        // I think the job won't exist here anymore
      }
    }
  } catch (error) {
    console.error("Failed to update job status:", error);
  }
};
