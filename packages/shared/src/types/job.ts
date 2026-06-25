export enum JobStatus {
  Backlog = 'backlog',
  Ready = 'ready',
  Running = 'running',
  InReview = 'in_review',
  Done = 'done',
  Cancelled = 'cancelled',
}

export enum JobPriority {
  High = 'high',
  Normal = 'normal',
  Low = 'low',
}
