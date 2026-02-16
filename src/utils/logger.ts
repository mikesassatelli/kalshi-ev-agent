import winston from "winston";

export function createLogger(level: string = "info") {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      winston.format.errors({ stack: true }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      })
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({
        filename: "logs/agent.log",
        format: winston.format.combine(
          winston.format.uncolorize(),
          winston.format.timestamp(),
          winston.format.json()
        ),
      }),
      new winston.transports.File({
        filename: "logs/trades.log",
        level: "info",
        format: winston.format.combine(
          winston.format.uncolorize(),
          winston.format.timestamp(),
          winston.format.json()
        ),
      }),
    ],
  });
}

export type Logger = winston.Logger;
