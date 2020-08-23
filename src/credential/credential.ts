/*!
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Use untyped import syntax for Node built-ins
import fs = require('fs');
import os = require('os');
import path = require('path');

import { AppErrorCodes, FirebaseAppError } from '../utils/error';
import { FirebaseApp } from '../firebase-app';
import { HttpClient, HttpRequestConfig, HttpError, HttpResponse } from '../utils/api-request';
import { Agent } from 'http';
import { FirebaseServiceInterface, FirebaseServiceInternalsInterface } from '../firebase-service';
import * as util from '../utils/validator';

const GOOGLE_TOKEN_AUDIENCE = 'https://accounts.google.com/o/oauth2/token';
const GOOGLE_AUTH_TOKEN_HOST = 'accounts.google.com';
const GOOGLE_AUTH_TOKEN_PATH = '/o/oauth2/token';

// NOTE: the Google Metadata Service uses HTTP over a vlan
const GOOGLE_METADATA_SERVICE_HOST = 'metadata.google.internal';
const GOOGLE_METADATA_SERVICE_TOKEN_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';
const GOOGLE_METADATA_SERVICE_PROJECT_ID_PATH = '/computeMetadata/v1/project/project-id';

const configDir = (() => {
  // Windows has a dedicated low-rights location for apps at ~/Application Data
  const sys = os.platform();
  if (sys && sys.length >= 3 && sys.substring(0, 3).toLowerCase() === 'win') {
    return process.env.APPDATA;
  }

  // On *nix the gcloud cli creates a . dir.
  return process.env.HOME && path.resolve(process.env.HOME, '.config');
})();

const GCLOUD_CREDENTIAL_SUFFIX = 'gcloud/application_default_credentials.json';
const GCLOUD_CREDENTIAL_PATH = configDir && path.resolve(configDir, GCLOUD_CREDENTIAL_SUFFIX);

const REFRESH_TOKEN_HOST = 'www.googleapis.com';
const REFRESH_TOKEN_PATH = '/oauth2/v4/token';

const ONE_HOUR_IN_SECONDS = 60 * 60;
const JWT_ALGORITHM = 'RS256';

let globalAppDefaultCred: Credential;
const globalCertCreds: { [key: string]: ServiceAccountCredential } = {};
const globalRefreshTokenCreds: { [key: string]: RefreshTokenCredential } = {};


/**
 * Interface for Google OAuth 2.0 access tokens.
 */
export interface GoogleOAuthAccessToken {
  /* tslint:disable:variable-name */
  access_token: string;
  expires_in: number;
  /* tslint:enable:variable-name */
}

/**
 * Interface that provides Google OAuth2 access tokens used to authenticate
 * with Firebase services.
 *
 * In most cases, you will not need to implement this yourself and can instead
 * use the default implementations provided by
 * {@link admin.credential `admin.credential`}.
 */
export interface Credential {
  /**
   * Returns a Google OAuth2 access token object used to authenticate with
   * Firebase services.
   *
   * This object contains the following properties:
   * * `access_token` (`string`): The actual Google OAuth2 access token.
   * * `expires_in` (`number`): The number of seconds from when the token was
   *   issued that it expires.
   *
   * @return A Google OAuth2 access token object.
   */
  getAccessToken(): Promise<GoogleOAuthAccessToken>;
}

/**
 * Internals of an InstanceId service instance.
 */
export class CredentialServiceInternals implements FirebaseServiceInternalsInterface {
  /**
   * Deletes the service and its associated resources.
   *
   * @return {Promise<()>} An empty Promise that will be fulfilled when the service is deleted.
   */
  public delete(): Promise<void> {
    // There are no resources to clean up
    return Promise.resolve(undefined);
  }
}


export class CredentialService implements FirebaseServiceInterface {
  public INTERNAL: CredentialServiceInternals = new CredentialServiceInternals();
  private readonly app_: FirebaseApp;

  /**
   * @param {object} app The app for this Auth service.
   * @constructor
   */
  constructor(app: FirebaseApp) {
    this.app_ = app;
  }

  /**
   * Returns the app associated with this Auth instance.
   *
   * @return {FirebaseApp} The app associated with this Auth instance.
   */
  get app(): FirebaseApp {
    return this.app_;
  }

  /**
   * Returns a credential created from the
   * {@link
   *    https://developers.google.com/identity/protocols/application-default-credentials
   *    Google Application Default Credentials}
   * that grants admin access to Firebase services. This credential can be used
   * in the call to
   * {@link
   *   https://firebase.google.com/docs/reference/admin/node/admin#.initializeApp
   *  `admin.initializeApp()`}.
   *
   * Google Application Default Credentials are available on any Google
   * infrastructure, such as Google App Engine and Google Compute Engine.
   *
   * See
   * {@link
   *   https://firebase.google.com/docs/admin/setup#initialize_the_sdk
   *   Initialize the SDK}
   * for more details.
   *
   * @example
   * ```javascript
   * admin.initializeApp({
   *   credential: admin.credential.applicationDefault(),
   *   databaseURL: "https://<DATABASE_NAME>.firebaseio.com"
   * });
   * ```
   *
   * @param {!Object=} httpAgent Optional [HTTP Agent](https://nodejs.org/api/http.html#http_class_http_agent)
   *   to be used when retrieving access tokens from Google token servers.
   *
   * @return {!admin.credential.Credential} A credential authenticated via Google
   *   Application Default Credentials that can be used to initialize an app.
   */
  static applicationDefault(httpAgent?: Agent): Credential {
    if (typeof globalAppDefaultCred === 'undefined') {
      globalAppDefaultCred = getApplicationDefault(httpAgent);
    }
    return globalAppDefaultCred;
  }

  /**
   * Returns a credential created from the provided service account that grants
   * admin access to Firebase services. This credential can be used in the call
   * to
   * {@link
   *   https://firebase.google.com/docs/reference/admin/node/admin#.initializeApp
   *   `admin.initializeApp()`}.
   *
   * See
   * {@link
   *   https://firebase.google.com/docs/admin/setup#initialize_the_sdk
   *   Initialize the SDK}
   * for more details.
   *
   * @example
   * ```javascript
   * // Providing a path to a service account key JSON file
   * var serviceAccount = require("path/to/serviceAccountKey.json");
   * admin.initializeApp({
   *   credential: admin.credential.cert(serviceAccount),
   *   databaseURL: "https://<DATABASE_NAME>.firebaseio.com"
   * });
   * ```
   *
   * @example
   * ```javascript
   * // Providing a service account object inline
   * admin.initializeApp({
   *   credential: admin.credential.cert({
   *     projectId: "<PROJECT_ID>",
   *     clientEmail: "foo@<PROJECT_ID>.iam.gserviceaccount.com",
   *     privateKey: "-----BEGIN PRIVATE KEY-----<KEY>-----END PRIVATE KEY-----\n"
   *   }),
   *   databaseURL: "https://<DATABASE_NAME>.firebaseio.com"
   * });
   * ```
   *
   * @param serviceAccountPathOrObject The path to a service
   *   account key JSON file or an object representing a service account key.
   * @param httpAgent Optional [HTTP Agent](https://nodejs.org/api/http.html#http_class_http_agent)
   *   to be used when retrieving access tokens from Google token servers.
   *
   * @return A credential authenticated via the
   *   provided service account that can be used to initialize an app.
   */
  static cert(serviceAccountPathOrObject: string | object, httpAgent?: Agent): Credential {
    const stringifiedServiceAccount = JSON.stringify(serviceAccountPathOrObject);
    if (!(stringifiedServiceAccount in globalCertCreds)) {
      globalCertCreds[stringifiedServiceAccount] = new ServiceAccountCredential(serviceAccountPathOrObject, httpAgent);
    }
    return globalCertCreds[stringifiedServiceAccount];
  }

  /**
   * Returns a credential created from the provided refresh token that grants
   * admin access to Firebase services. This credential can be used in the call
   * to
   * {@link
   *   https://firebase.google.com/docs/reference/admin/node/admin#.initializeApp
   *   `admin.initializeApp()`}.
   *
   * See
   * {@link
   *   https://firebase.google.com/docs/admin/setup#initialize_the_sdk
   *   Initialize the SDK}
   * for more details.
   *
   * @example
   * ```javascript
   * // Providing a path to a refresh token JSON file
   * var refreshToken = require("path/to/refreshToken.json");
   * admin.initializeApp({
   *   credential: admin.credential.refreshToken(refreshToken),
   *   databaseURL: "https://<DATABASE_NAME>.firebaseio.com"
   * });
   * ```
   *
   * @param refreshTokenPathOrObject The path to a Google
   *   OAuth2 refresh token JSON file or an object representing a Google OAuth2
   *   refresh token.
   * @param httpAgent Optional [HTTP Agent](https://nodejs.org/api/http.html#http_class_http_agent)
   *   to be used when retrieving access tokens from Google token servers.
   *
   * @return A credential authenticated via the
   *   provided service account that can be used to initialize an app.
   */
  static refreshToken(refreshTokenPathOrObject: string | object, httpAgent?: Agent): Credential {
    const stringifiedRefreshToken = JSON.stringify(refreshTokenPathOrObject);
    if (!(stringifiedRefreshToken in globalRefreshTokenCreds)) {
      globalRefreshTokenCreds[stringifiedRefreshToken] = new RefreshTokenCredential(
        refreshTokenPathOrObject, httpAgent);
    }
    return globalRefreshTokenCreds[stringifiedRefreshToken];
  }
}

/**
 * Implementation of Credential that uses a service account.
 */
export class ServiceAccountCredential implements Credential {

  public readonly projectId: string;
  public readonly privateKey: string;
  public readonly clientEmail: string;

  private readonly httpClient: HttpClient;

  /**
   * Creates a new ServiceAccountCredential from the given parameters.
   *
   * @param serviceAccountPathOrObject Service account json object or path to a service account json file.
   * @param httpAgent Optional http.Agent to use when calling the remote token server.
   * @param implicit An optinal boolean indicating whether this credential was implicitly discovered from the
   *   environment, as opposed to being explicitly specified by the developer.
   *
   * @constructor
   */
  constructor(
    serviceAccountPathOrObject: string | object,
    private readonly httpAgent?: Agent,
    readonly implicit: boolean = false) {

    const serviceAccount = (typeof serviceAccountPathOrObject === 'string') ?
      ServiceAccount.fromPath(serviceAccountPathOrObject)
      : new ServiceAccount(serviceAccountPathOrObject);
    this.projectId = serviceAccount.projectId;
    this.privateKey = serviceAccount.privateKey;
    this.clientEmail = serviceAccount.clientEmail;
    this.httpClient = new HttpClient();
  }

  public getAccessToken(): Promise<GoogleOAuthAccessToken> {
    const token = this.createAuthJwt_();
    const postData = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3A' +
      'grant-type%3Ajwt-bearer&assertion=' + token;
    const request: HttpRequestConfig = {
      method: 'POST',
      url: `https://${GOOGLE_AUTH_TOKEN_HOST}${GOOGLE_AUTH_TOKEN_PATH}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: postData,
      httpAgent: this.httpAgent,
    };
    return requestAccessToken(this.httpClient, request);
  }

  private createAuthJwt_(): string {
    const claims = {
      scope: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/firebase.database',
        'https://www.googleapis.com/auth/firebase.messaging',
        'https://www.googleapis.com/auth/identitytoolkit',
        'https://www.googleapis.com/auth/userinfo.email',
      ].join(' '),
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwt = require('jsonwebtoken');
    // This method is actually synchronous so we can capture and return the buffer.
    return jwt.sign(claims, this.privateKey, {
      audience: GOOGLE_TOKEN_AUDIENCE,
      expiresIn: ONE_HOUR_IN_SECONDS,
      issuer: this.clientEmail,
      algorithm: JWT_ALGORITHM,
    });
  }
}

/**
 * A struct containing the properties necessary to use service account JSON credentials.
 */
class ServiceAccount {

  public readonly projectId: string;
  public readonly privateKey: string;
  public readonly clientEmail: string;

  public static fromPath(filePath: string): ServiceAccount {
    try {
      return new ServiceAccount(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      // Throw a nicely formed error message if the file contents cannot be parsed
      throw new FirebaseAppError(
        AppErrorCodes.INVALID_CREDENTIAL,
        'Failed to parse service account json file: ' + error,
      );
    }
  }

  constructor(json: object) {
    if (!util.isNonNullObject(json)) {
      throw new FirebaseAppError(
        AppErrorCodes.INVALID_CREDENTIAL,
        'Service account must be an object.',
      );
    }

    copyAttr(this, json, 'projectId', 'project_id');
    copyAttr(this, json, 'privateKey', 'private_key');
    copyAttr(this, json, 'clientEmail', 'client_email');

    let errorMessage;
    if (!util.isNonEmptyString(this.projectId)) {
      errorMessage = 'Service account object must contain a string "project_id" property.';
    } else if (!util.isNonEmptyString(this.privateKey)) {
      errorMessage = 'Service account object must contain a string "private_key" property.';
    } else if (!util.isNonEmptyString(this.clientEmail)) {
      errorMessage = 'Service account object must contain a string "client_email" property.';
    }

    if (typeof errorMessage !== 'undefined') {
      throw new FirebaseAppError(AppErrorCodes.INVALID_CREDENTIAL, errorMessage);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forge = require('node-forge');
    try {
      forge.pki.privateKeyFromPem(this.privateKey);
    } catch (error) {
      throw new FirebaseAppError(
        AppErrorCodes.INVALID_CREDENTIAL,
        'Failed to parse private key: ' + error);
    }
  }
}

/**
 * Implementation of Credential that gets access tokens from the metadata service available
 * in the Google Cloud Platform. This authenticates the process as the default service account
 * of an App Engine instance or Google Compute Engine machine.
 */
export class ComputeEngineCredential implements Credential {

  private readonly httpClient = new HttpClient();
  private readonly httpAgent?: Agent;
  private projectId?: string;

  constructor(httpAgent?: Agent) {
    this.httpAgent = httpAgent;
  }

  public getAccessToken(): Promise<GoogleOAuthAccessToken> {
    const request = this.buildRequest(GOOGLE_METADATA_SERVICE_TOKEN_PATH);
    return requestAccessToken(this.httpClient, request);
  }

  public getProjectId(): Promise<string> {
    if (this.projectId) {
      return Promise.resolve(this.projectId);
    }

    const request = this.buildRequest(GOOGLE_METADATA_SERVICE_PROJECT_ID_PATH);
    return this.httpClient.send(request)
      .then((resp) => {
        this.projectId = resp.text!;
        return this.projectId;
      })
      .catch((err) => {
        const detail: string = (err instanceof HttpError) ? getDetailFromResponse(err.response) : err.message;
        throw new FirebaseAppError(
          AppErrorCodes.INVALID_CREDENTIAL,
          `Failed to determine project ID: ${detail}`);
      });
  }

  private buildRequest(urlPath: string): HttpRequestConfig {
    return {
      method: 'GET',
      url: `http://${GOOGLE_METADATA_SERVICE_HOST}${urlPath}`,
      headers: {
        'Metadata-Flavor': 'Google',
      },
      httpAgent: this.httpAgent,
    };
  }
}

/**
 * Implementation of Credential that gets access tokens from refresh tokens.
 */
export class RefreshTokenCredential implements Credential {

  private readonly refreshToken: RefreshToken;
  private readonly httpClient: HttpClient;

  /**
   * Creates a new RefreshTokenCredential from the given parameters.
   *
   * @param refreshTokenPathOrObject Refresh token json object or path to a refresh token (user credentials) json file.
   * @param httpAgent Optional http.Agent to use when calling the remote token server.
   * @param implicit An optinal boolean indicating whether this credential was implicitly discovered from the
   *   environment, as opposed to being explicitly specified by the developer.
   *
   * @constructor
   */
  constructor(
    refreshTokenPathOrObject: string | object,
    private readonly httpAgent?: Agent,
    readonly implicit: boolean = false) {

    this.refreshToken = (typeof refreshTokenPathOrObject === 'string') ?
      RefreshToken.fromPath(refreshTokenPathOrObject)
      : new RefreshToken(refreshTokenPathOrObject);
    this.httpClient = new HttpClient();
  }

  public getAccessToken(): Promise<GoogleOAuthAccessToken> {
    const postData =
      'client_id=' + this.refreshToken.clientId + '&' +
      'client_secret=' + this.refreshToken.clientSecret + '&' +
      'refresh_token=' + this.refreshToken.refreshToken + '&' +
      'grant_type=refresh_token';
    const request: HttpRequestConfig = {
      method: 'POST',
      url: `https://${REFRESH_TOKEN_HOST}${REFRESH_TOKEN_PATH}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: postData,
      httpAgent: this.httpAgent,
    };
    return requestAccessToken(this.httpClient, request);
  }
}

class RefreshToken {

  public readonly clientId: string;
  public readonly clientSecret: string;
  public readonly refreshToken: string;
  public readonly type: string;

  /*
   * Tries to load a RefreshToken from a path. Throws if the path doesn't exist or the
   * data at the path is invalid.
   */
  public static fromPath(filePath: string): RefreshToken {
    try {
      return new RefreshToken(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      // Throw a nicely formed error message if the file contents cannot be parsed
      throw new FirebaseAppError(
        AppErrorCodes.INVALID_CREDENTIAL,
        'Failed to parse refresh token file: ' + error,
      );
    }
  }

  constructor(json: object) {
    copyAttr(this, json, 'clientId', 'client_id');
    copyAttr(this, json, 'clientSecret', 'client_secret');
    copyAttr(this, json, 'refreshToken', 'refresh_token');
    copyAttr(this, json, 'type', 'type');

    let errorMessage;
    if (!util.isNonEmptyString(this.clientId)) {
      errorMessage = 'Refresh token must contain a "client_id" property.';
    } else if (!util.isNonEmptyString(this.clientSecret)) {
      errorMessage = 'Refresh token must contain a "client_secret" property.';
    } else if (!util.isNonEmptyString(this.refreshToken)) {
      errorMessage = 'Refresh token must contain a "refresh_token" property.';
    } else if (!util.isNonEmptyString(this.type)) {
      errorMessage = 'Refresh token must contain a "type" property.';
    }

    if (typeof errorMessage !== 'undefined') {
      throw new FirebaseAppError(AppErrorCodes.INVALID_CREDENTIAL, errorMessage);
    }
  }
}

export function getApplicationDefault(httpAgent?: Agent): Credential {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return credentialFromFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, httpAgent);
  }

  // It is OK to not have this file. If it is present, it must be valid.
  if (GCLOUD_CREDENTIAL_PATH) {
    const refreshToken = readCredentialFile(GCLOUD_CREDENTIAL_PATH, true);
    if (refreshToken) {
      return new RefreshTokenCredential(refreshToken, httpAgent, true);
    }
  }

  return new ComputeEngineCredential(httpAgent);
}

/**
 * Checks if the given credential was loaded via the application default credentials mechanism. This
 * includes all ComputeEngineCredential instances, and the ServiceAccountCredential and RefreshTokenCredential
 * instances that were loaded from well-known files or environment variables, rather than being explicitly
 * instantiated.
 *
 * @param credential The credential instance to check.
 */
export function isApplicationDefault(credential?: Credential): boolean {
  return credential instanceof ComputeEngineCredential ||
    (credential instanceof ServiceAccountCredential && credential.implicit) ||
    (credential instanceof RefreshTokenCredential && credential.implicit);
}

/**
 * Copies the specified property from one object to another.
 *
 * If no property exists by the given "key", looks for a property identified by "alt", and copies it instead.
 * This can be used to implement behaviors such as "copy property myKey or my_key".
 *
 * @param to Target object to copy the property into.
 * @param from Source object to copy the property from.
 * @param key Name of the property to copy.
 * @param alt Alternative name of the property to copy.
 */
function copyAttr(to: {[key: string]: any}, from: {[key: string]: any}, key: string, alt: string): void {
  const tmp = from[key] || from[alt];
  if (typeof tmp !== 'undefined') {
    to[key] = tmp;
  }
}

/**
 * Obtain a new OAuth2 token by making a remote service call.
 */
function requestAccessToken(client: HttpClient, request: HttpRequestConfig): Promise<GoogleOAuthAccessToken> {
  return client.send(request).then((resp) => {
    const json = resp.data;
    if (!json.access_token || !json.expires_in) {
      throw new FirebaseAppError(
        AppErrorCodes.INVALID_CREDENTIAL,
        `Unexpected response while fetching access token: ${ JSON.stringify(json) }`,
      );
    }
    return json;
  }).catch((err) => {
    throw new FirebaseAppError(AppErrorCodes.INVALID_CREDENTIAL, getErrorMessage(err));
  });
}

/**
 * Constructs a human-readable error message from the given Error.
 */
function getErrorMessage(err: Error): string {
  const detail: string = (err instanceof HttpError) ? getDetailFromResponse(err.response) : err.message;
  return `Error fetching access token: ${detail}`;
}

/**
 * Extracts details from the given HTTP error response, and returns a human-readable description. If
 * the response is JSON-formatted, looks up the error and error_description fields sent by the
 * Google Auth servers. Otherwise returns the entire response payload as the error detail.
 */
function getDetailFromResponse(response: HttpResponse): string {
  if (response.isJson() && response.data.error) {
    const json = response.data;
    let detail = json.error;
    if (json.error_description) {
      detail += ' (' + json.error_description + ')';
    }
    return detail;
  }
  return response.text || 'Missing error payload';
}

function credentialFromFile(filePath: string, httpAgent?: Agent): Credential {
  const credentialsFile = readCredentialFile(filePath);
  if (typeof credentialsFile !== 'object' || credentialsFile === null) {
    throw new FirebaseAppError(
      AppErrorCodes.INVALID_CREDENTIAL,
      'Failed to parse contents of the credentials file as an object',
    );
  }

  if (credentialsFile.type === 'service_account') {
    return new ServiceAccountCredential(credentialsFile, httpAgent, true);
  }

  if (credentialsFile.type === 'authorized_user') {
    return new RefreshTokenCredential(credentialsFile, httpAgent, true);
  }

  throw new FirebaseAppError(
    AppErrorCodes.INVALID_CREDENTIAL,
    'Invalid contents in the credentials file',
  );
}

function readCredentialFile(filePath: string, ignoreMissing?: boolean): {[key: string]: any} | null {
  let fileText: string;
  try {
    fileText = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (ignoreMissing) {
      return null;
    }

    throw new FirebaseAppError(
      AppErrorCodes.INVALID_CREDENTIAL,
      `Failed to read credentials from file ${filePath}: ` + error,
    );
  }

  try {
    return JSON.parse(fileText);
  } catch (error) {
    throw new FirebaseAppError(
      AppErrorCodes.INVALID_CREDENTIAL,
      'Failed to parse contents of the credentials file as an object: ' + error,
    );
  }
}
