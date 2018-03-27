
import * as moment from 'moment-timezone';
import * as Mailgun from 'mailgun-js';
import { v1 as uuid } from 'uuid';

import { ICallback, IEventPayload, HTTPStatusCodes } from '../lambdaTypes';

import { isObjectEmpty, objectOnlyContainsKeys } from '../utilities';
import { dynamoDBScanPromise } from '../dynamoDBUtilities';

import { readFileSync } from 'fs';


const mailgun = Mailgun({
  apiKey: process.env.mailgunAPIKey,
  domain: process.env.mailgunDomain,
});

export const sendReminders = async (event: IEventPayload, context, callback: ICallback) => {
  try {
    const sixMonthsPast = moment()
      .tz('America/New_York')
      .subtract(6, 'months')
      .format('M/D/YYYY');

    const scanParams = {
      TableName: process.env.tableName,
      FilterExpression: 'signed_up_date = :six_months_past',
      ExpressionAttributeValues: { ':six_months_past': sixMonthsPast }
    };

    const results = await dynamoDBScanPromise(scanParams);
    const emailsChunkedBySubcategory = results.Items.reduce((obj, emailUser) => {
      const subcategory = emailUser.subcategory;
      obj[subcategory] = (obj[subcategory] || []).concat(emailUser);

      return obj;
    }, {});

    const functionName = context.functionName.split('-').pop();
    const from = `We Are Nature <WeAreNaturePGH@${process.env.mailgunDomain}>`;

    // Bug 1: if the db query retured no objects, the lambda callback was not being triggered
    // since it was only in the forEach case when there are emails to be sent
    if (Object.keys(emailsChunkedBySubcategory).length === 0) {
      callback(null, {
        statusCode: HTTPStatusCodes.OK,
        body: JSON.stringify(results),
      });
      return;
    }


    // Bug 2: 'emails' variable might contain bad emails as they are not validated.
    // Filter invalid emails to prevent .send call from failing
    Object.keys(emailsChunkedBySubcategory).forEach(function(subcategory) {
      const chunk = emailsChunkedBySubcategory[subcategory];
      const emails = chunk.map(emailUser => emailUser.email);
      const uniqueEmailKeys = emails.reduce((obj, email) => {
        obj[email] = { id: uuid() };
        return obj;
      }, {});

      const html = readFileSync(`./src/${functionName}/emails/reminder${subcategory}.html`, 'utf8');

      const emailData = {
        from,
        to: emails,
        // "recipient-variables" is required for batch sending
        "recipient-variables": uniqueEmailKeys,
        subject: "Did you follow through with your pledge?",
        html,
      };
  
      mailgun.messages().send(emailData, function (e) {
        // Bug 3: callback not called when send is complete causing a lambda timeout
        if (e) {
          callback(e, {
            statusCode: HTTPStatusCodes.InternalServerError,
            body: JSON.stringify({count: results.Count, scanned: results.ScannedCount}),
          });
          console.log(e);
        } else {
          callback(null, {
            statusCode: HTTPStatusCodes.OK,
            body: JSON.stringify({count: results.Count, scanned: results.ScannedCount}),
          });
        }
      });
    });
  } catch (e) {
    console.log(e);

    callback(null, {
      statusCode: HTTPStatusCodes.InternalServerError,
      body: "Server Error. Check server error logs.",
    });
  }
}
