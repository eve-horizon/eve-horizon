# 50 - Cross-Project App Links: Events

1. Complete scenario 47 with an active event subscription.
2. In the consumer manifest, add a workflow trigger:

   ```yaml
   trigger:
     app_link:
       alias: observation
       type: app.observation.created
   ```

3. Emit `app.observation.created` in the producer project.
4. Wait for the orchestrator to process the producer event.
5. Verify `eve event list --project <consumer> --source app_link` shows a consumer event with the same type.
6. Verify `eve event show <producer_event_id>` includes an `app_link` trigger evaluation with the subscription and delivery IDs.
7. Re-emit the same producer event with the same dedupe key and verify only one consumer event exists.
8. Revoke the event grant, emit again, and verify no new consumer `app_link` event is created.
