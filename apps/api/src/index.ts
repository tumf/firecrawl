import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import "dotenv/config";
import { getWebScraperQueue } from "./services/queue-service";
import { redisClient } from "./services/rate-limiter";
import { v0Router } from "./routes/v0";
import { initSDK } from "@hyperdx/node-opentelemetry";
import cluster from "cluster";
import os from "os";
import { Job } from "bull";
import { sendSlackWebhook } from "./services/alerts/slack";
import { checkAlerts } from "./services/alerts";

const { createBullBoard } = require("@bull-board/api");
const { BullAdapter } = require("@bull-board/api/bullAdapter");
const { ExpressAdapter } = require("@bull-board/express");

const numCPUs = process.env.ENV === "local" ? 2 : os.cpus().length;
console.log(`Number of CPUs: ${numCPUs} available`);

if (cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    if (code !== null) {
      console.log(`Worker ${worker.process.pid} exited`);
      console.log("Starting a new worker");
      cluster.fork();
    }
  });

} else {
  const app = express();


  global.isProduction = process.env.IS_PRODUCTION === "true";

  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json({ limit: "10mb" }));

  app.use(cors()); // Add this line to enable CORS

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(`/admin/${process.env.BULL_AUTH_KEY}/queues`);

  const { addQueue, removeQueue, setQueues, replaceQueues } = createBullBoard({
    queues: [new BullAdapter(getWebScraperQueue())],
    serverAdapter: serverAdapter,
  });

  app.use(
    `/admin/${process.env.BULL_AUTH_KEY}/queues`,
    serverAdapter.getRouter()
  );

  app.get("/", (req, res) => {
    res.send("SCRAPERS-JS: Hello, world! Fly.io");
  });

  //write a simple test function
  app.get("/test", async (req, res) => {
    res.send("Hello, world!");
  });

  // register router
  app.use(v0Router);

  const DEFAULT_PORT = process.env.PORT ?? 3002;
  const HOST = process.env.HOST ?? "localhost";
  redisClient.connect();

  // HyperDX OpenTelemetry
  if (process.env.ENV === "production") {
    initSDK({ consoleCapture: true, additionalInstrumentations: [] });
  }

  function startServer(port = DEFAULT_PORT) {
    const server = app.listen(Number(port), HOST, () => {
      console.log(`Worker ${process.pid} listening on port ${port}`);
      console.log(
        `For the UI, open http://${HOST}:${port}/admin/${process.env.BULL_AUTH_KEY}/queues`
      );
      console.log("");
      console.log("1. Make sure Redis is running on port 6379 by default");
      console.log(
        "2. If you want to run nango, make sure you do port forwarding in 3002 using ngrok http 3002 "
      );
    });
    return server;
  }

  if (require.main === module) {
    startServer();
  }

  // Use this as a "health check" that way we dont destroy the server
  app.get(`/admin/${process.env.BULL_AUTH_KEY}/queues`, async (req, res) => {
    try {
      const webScraperQueue = getWebScraperQueue();

      const [webScraperActive] = await Promise.all([
        webScraperQueue.getActiveCount(),
      ]);

      const noActiveJobs = webScraperActive === 0;
      // 200 if no active jobs, 503 if there are active jobs
      return res.status(noActiveJobs ? 200 : 500).json({
        webScraperActive,
        noActiveJobs,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post(`/admin/${process.env.BULL_AUTH_KEY}/shutdown`, async (req, res) => {

    // return res.status(200).json({ ok: true });
    try {
      console.log("Gracefully shutting down...");
      await getWebScraperQueue().pause(false, true);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  });

  app.post(`/admin/${process.env.BULL_AUTH_KEY}/unpause`, async (req, res) => {
    try {
      const wsq = getWebScraperQueue();

      const jobs = await wsq.getActive();
        
      console.log("Requeueing", jobs.length, "jobs...");

      if (jobs.length > 0) {
        console.log("  Removing", jobs.length, "jobs...");

        await Promise.all(jobs.map(async x => {
          try {
            await wsq.client.del(await x.lockKey());
            await x.takeLock();
            await x.moveToFailed({ message: "interrupted" });
            await x.remove();
          } catch (e) {
            console.warn("Failed to remove job", x.id, e);
          }
        }));

        console.log("  Re-adding", jobs.length, "jobs...");
        await wsq.addBulk(jobs.map(x => ({
          data: x.data,
          opts: {
            jobId: x.id,
          },
        })));

        console.log("  Done!");
      }
      
      await getWebScraperQueue().resume(false);
      res.json({ ok: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get(`/serverHealthCheck`, async (req, res) => {
    try {
      const webScraperQueue = getWebScraperQueue();
      const [waitingJobs] = await Promise.all([
        webScraperQueue.getWaitingCount(),
      ]);

      const noWaitingJobs = waitingJobs === 0;
      // 200 if no active jobs, 503 if there are active jobs
      return res.status(noWaitingJobs ? 200 : 500).json({
        waitingJobs,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get("/serverHealthCheck/notify", async (req, res) => {
    if (process.env.SLACK_WEBHOOK_URL) {
      const treshold = 1; // The treshold value for the active jobs
      const timeout = 60000; // 1 minute // The timeout value for the check in milliseconds

      const getWaitingJobsCount = async () => {
        const webScraperQueue = getWebScraperQueue();
        const [waitingJobsCount] = await Promise.all([
          webScraperQueue.getWaitingCount(),
        ]);

        return waitingJobsCount;
      };

      res.status(200).json({ message: "Check initiated" });

      const checkWaitingJobs = async () => {
        try {
          let waitingJobsCount = await getWaitingJobsCount();
          if (waitingJobsCount >= treshold) {
            setTimeout(async () => {
              // Re-check the waiting jobs count after the timeout
              waitingJobsCount = await getWaitingJobsCount();
              if (waitingJobsCount >= treshold) {
                const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
                const message = {
                  text: `⚠️ Warning: The number of active jobs (${waitingJobsCount}) has exceeded the threshold (${treshold}) for more than ${
                    timeout / 60000
                  } minute(s).`,
                };

                const response = await fetch(slackWebhookUrl, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify(message),
                });

                if (!response.ok) {
                  console.error("Failed to send Slack notification");
                }
              }
            }, timeout);
          }
        } catch (error) {
          console.error(error);
        }
      };

      checkWaitingJobs();
    }
  });

  app.get(
    `/admin/${process.env.BULL_AUTH_KEY}/check-queues`,
    async (req, res) => {
      try {
        await checkAlerts();
        return res.status(200).send("Alerts initialized");
      } catch (error) {
        console.error("Failed to initialize alerts:", error);
        return res.status(500).send("Failed to initialize alerts");
      }
    }
  );

  app.get(
    `/admin/${process.env.BULL_AUTH_KEY}/clean-before-24h-complete-jobs`,
    async (req, res) => {
      try {
        const webScraperQueue = getWebScraperQueue();
        const batchSize = 10;
        const numberOfBatches = 9; // Adjust based on your needs
        const completedJobsPromises: Promise<Job[]>[] = [];
        for (let i = 0; i < numberOfBatches; i++) {
          completedJobsPromises.push(webScraperQueue.getJobs(
            ["completed"],
            i * batchSize,
            i * batchSize + batchSize,
            true
          ));
        }
        const completedJobs: Job[] = (await Promise.all(completedJobsPromises)).flat();
        const before24hJobs = completedJobs.filter(
          (job) => job.finishedOn < Date.now() - 24 * 60 * 60 * 1000
        ) || [];
        
        let count = 0;
        
        if (!before24hJobs) {
          return res.status(200).send(`No jobs to remove.`);
        }

        for (const job of before24hJobs) {
          try {
            await job.remove()
            count++;
          } catch (jobError) {
            console.error(`Failed to remove job with ID ${job.id}:`, jobError);
          }
        }
        return res.status(200).send(`Removed ${count} completed jobs.`);
      } catch (error) {
        console.error("Failed to clean last 24h complete jobs:", error);
        return res.status(500).send("Failed to clean jobs");
      }
    }
  );

  app.get("/is-production", (req, res) => {
    res.send({ isProduction: global.isProduction });
  });


  

  console.log(`Worker ${process.pid} started`);
}
