import crypto from 'node:crypto'
import type { PoolConnection } from 'mysql2/promise'

import { pool } from '../config/db'

export type NotificationTone =
  | 'INFO'
  | 'SUCCESS'
  | 'WARNING'

export type CreateNotificationInput = {
  userId: number

  type: string

  title: string

  body: string

  entityType?: string | null

  entityId?: string | null

  tone?: NotificationTone
}

/* =========================================================
   LOW-LEVEL NOTIFICATION INSERT
========================================================= */

export async function createNotification(
  input: CreateNotificationInput,
  connection?: PoolConnection,
) {
  const runner =
    connection ??
    pool

  await runner.execute(
    `
      INSERT INTO notifications (
        public_id,
        user_id,
        type,
        title,
        body,
        entity_type,
        entity_id,
        tone,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
    `,
    [
      crypto.randomUUID(),

      input.userId,

      input.type,

      input.title,

      input.body,

      input.entityType ??
        null,

      input.entityId ??
        null,

      input.tone ??
        'INFO',
    ],
  )
}

/* =========================================================
   REQUEST CREATED

   Recipient:
   - user who submitted the request
========================================================= */

export async function notifyRequestCreated(
  input: {
    userId: number

    requestCode: string
  },

  connection?: PoolConnection,
) {
  await createNotification(
    {
      userId:
        input.userId,

      type:
        'REQUEST_CREATED',

      title:
        'Request received',

      body:
        `${input.requestCode} has been submitted successfully.`,

      entityType:
        'SERVICE_REQUEST',

      entityId:
        input.requestCode,

      tone:
        'INFO',
    },

    connection,
  )
}

/* =========================================================
   REQUEST ASSIGNMENT / REASSIGNMENT

   FIRST ASSIGNMENT

   New officer:
   REQUEST_ASSIGNED

   Citizen:
   REQUEST_ASSIGNED


   REASSIGNMENT

   New officer:
   REQUEST_REASSIGNED

   Old officer:
   ASSIGNMENT_REMOVED

   Citizen:
   REQUEST_REASSIGNED
========================================================= */

export async function notifyRequestAssignment(
  input: {
    requestCode: string

    citizenUserId: number

    newOfficerUserId: number

    previousOfficerUserId:
      number | null
  },

  connection?: PoolConnection,
) {
  const isReassignment =
    input.previousOfficerUserId !==
      null &&
    input.previousOfficerUserId !==
      input.newOfficerUserId

  /* =====================================================
     REASSIGNMENT
  ===================================================== */

  if (
    isReassignment
  ) {
    /*
      Notify new officer.
    */
    await createNotification(
      {
        userId:
          input.newOfficerUserId,

        type:
          'REQUEST_REASSIGNED',

        title:
          'Request reassigned to you',

        body:
          `${input.requestCode} has been reassigned to you.`,

        entityType:
          'SERVICE_REQUEST',

        entityId:
          input.requestCode,

        tone:
          'INFO',
      },

      connection,
    )

    /*
      Notify previous officer.
    */
    await createNotification(
      {
        userId:
          input.previousOfficerUserId!,

        type:
          'ASSIGNMENT_REMOVED',

        title:
          'Assignment removed',

        body:
          `${input.requestCode} has been reassigned to another officer.`,

        entityType:
          'SERVICE_REQUEST',

        entityId:
          input.requestCode,

        tone:
          'WARNING',
      },

      connection,
    )

    /*
      Notify citizen.
    */
    await createNotification(
      {
        userId:
          input.citizenUserId,

        type:
          'REQUEST_REASSIGNED',

        title:
          'Officer reassigned',

        body:
          `A different municipal officer has been assigned to ${input.requestCode}.`,

        entityType:
          'SERVICE_REQUEST',

        entityId:
          input.requestCode,

        tone:
          'INFO',
      },

      connection,
    )

    return
  }

  /* =====================================================
     FIRST ASSIGNMENT
  ===================================================== */

  await createNotification(
    {
      userId:
        input.newOfficerUserId,

      type:
        'REQUEST_ASSIGNED',

      title:
        'New request assigned',

      body:
        `${input.requestCode} has been assigned to you.`,

      entityType:
        'SERVICE_REQUEST',

      entityId:
        input.requestCode,

      tone:
        'INFO',
    },

    connection,
  )

  await createNotification(
    {
      userId:
        input.citizenUserId,

      type:
        'REQUEST_ASSIGNED',

      title:
        'Your request was assigned',

      body:
        `${input.requestCode} has been assigned to a municipal officer.`,

      entityType:
        'SERVICE_REQUEST',

      entityId:
        input.requestCode,

      tone:
        'INFO',
    },

    connection,
  )
}

/* =========================================================
   REQUEST STATUS NOTIFICATIONS

   Cleaner notification types are used for important
   business states.

   ACTION_REQUIRED
   REQUEST_RESOLVED
   REQUEST_CLOSED

   Other statuses continue using STATUS_CHANGED.
========================================================= */

export async function notifyRequestStatusChanged(
  input: {
    userId: number

    requestCode: string

    toStatus: string
  },

  connection?: PoolConnection,
) {
  switch (
    input.toStatus
  ) {
    /* =====================================================
       ACTION REQUIRED
    ===================================================== */

    case 'ACTION_REQUIRED': {
      await createNotification(
        {
          userId:
            input.userId,

          type:
            'ACTION_REQUIRED',

          title:
            'Action required',

          body:
            `Additional action is required for ${input.requestCode}. Please review the request details.`,

          entityType:
            'SERVICE_REQUEST',

          entityId:
            input.requestCode,

          tone:
            'WARNING',
        },

        connection,
      )

      return
    }

    /* =====================================================
       RESOLVED
    ===================================================== */

    case 'RESOLVED': {
      await createNotification(
        {
          userId:
            input.userId,

          type:
            'REQUEST_RESOLVED',

          title:
            'Request resolved',

          body:
            `${input.requestCode} has been resolved.`,

          entityType:
            'SERVICE_REQUEST',

          entityId:
            input.requestCode,

          tone:
            'SUCCESS',
        },

        connection,
      )

      return
    }

    /* =====================================================
       CLOSED
    ===================================================== */

    case 'CLOSED': {
      await createNotification(
        {
          userId:
            input.userId,

          type:
            'REQUEST_CLOSED',

          title:
            'Request closed',

          body:
            `${input.requestCode} has been closed.`,

          entityType:
            'SERVICE_REQUEST',

          entityId:
            input.requestCode,

          tone:
            'SUCCESS',
        },

        connection,
      )

      return
    }

    /* =====================================================
       OTHER STATUS CHANGES
    ===================================================== */

    default: {
      await createNotification(
        {
          userId:
            input.userId,

          type:
            'STATUS_CHANGED',

          title:
            'Request status updated',

          body:
            `${input.requestCode} is now ${input.toStatus
              .replaceAll(
                '_',
                ' ',
              )
              .toLowerCase()}.`,

          entityType:
            'SERVICE_REQUEST',

          entityId:
            input.requestCode,

          tone:
            'INFO',
        },

        connection,
      )
    }
  }
}