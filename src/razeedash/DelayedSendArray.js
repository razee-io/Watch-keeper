/**
 * Copyright 2019, 2022 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const objectPath = require('object-path');
const validUrl = require('valid-url');
const requestretry = require('requestretry');
const HttpAgent = require('agentkeepalive');
const HttpsAgent = require('agentkeepalive').HttpsAgent;
const log = require('../bunyan-api').createLogger('DelayedSendArray');
const Config = require('../Config');

const httpsAgent = new HttpsAgent({
  keepAlive: true
});
const httpAgent = new HttpAgent({
  keepAlive: true
});

const _queueObject = Symbol('queueObject');

module.exports = class DelayedSendArray {

  constructor(url, clusterID, max, trackSendPromises) {
    this._clusterID = clusterID;
    this.url = url;
    if (!this._clusterID) {
      throw Error('clusterID must be defined');
    }
    if (!validUrl.isUri(url)) {
      throw Error(`${url} not valid.`);
    }
    if (url.startsWith('https')) {
      this.agent = httpsAgent;
    } else {
      this.agent = httpAgent;
    }

    this.sendObject = [];
    this._maxItems = Number.isInteger(max) ? max : 50;
    this._trackSendPromises = trackSendPromises || false;
    this._sendPromises = [];
    if (this._trackSendPromises) {
      this._pollStarted = new Date(Date.now());
    }
  }

  get maxItems() {
    return this._maxItems;
  }

  getSendPromises() {
    return this._sendPromises;
  }

  // private methods
  [_queueObject](o) {
    if (o.constructor === {}.constructor) {
      this.sendObject.push(o);
    } else {
      const type = typeof o;
      throw `Type ${type} not supported.`;
    }
  }

  // public methods
  send(o) {
    if (Array.isArray(o)) {
      o.forEach((e) => { this[_queueObject](e); });
    } else {
      this[_queueObject](o);
    }

    if (this.sendObject.length >= this.maxItems) {
      this.flush();
    } else if (this.sendObject.length > 0 && !this.flushTimeout) {
      this.flushTimeout = setTimeout(() => {
        this.flush();
      }, 1000);
    }
  }

  flush() {
    clearTimeout(this.flushTimeout);
    this.flushTimeout = undefined;
    if (this.sendObject.length > 0) {
      const outBoundArray = this.sendObject;
      this.sendObject = [];
      const httpMethod = 'POST';
      const res = this.httpCall(httpMethod, outBoundArray);
      if (this._trackSendPromises) {
        this._sendPromises.push(res);
      }
    }
  }

  async httpCall(httpMethod, data, options = {}) {
    const url = `${this.url}/clusters/${this._clusterID}/${options.endpoint || 'resources'}`;

    // Log how many resources are being sent, and list any RemoteResources by selfLink
    const dArr = Array.isArray(data) ? data : [data];
    const remoteResourceSelfLinks = dArr.filter( d => objectPath.get( d, 'object.kind', '' ) == 'RemoteResource' ).map( d => objectPath.get( d, 'object.metadata.annotations.selfLink', 'no-selfLink' ) );
    log.info(`${httpMethod} ${dArr.length} resource(s) to ${url} starting. RemoteResource(s): ${remoteResourceSelfLinks.join( ', ' )}`);

    return requestretry({
      url: url,
      method: httpMethod,
      agent: this.agent,
      headers: {
        'razee-org-key': Config.orgKey,
        'poll-cycle': this._pollStarted
      },
      json: true,
      body: data,

      maxAttempts: options.maxAttempts || 5, // (default) try 5 times
      retryDelay: options.retryDelay || 3000, // (default) wait for 3s before trying again
      retryStrategy: options.retryStrategy || requestretry.RetryStrategies.HTTPOrNetworkError // (default) retry on 5xx or network errors
    }).then(function (response) {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        log.info(`${httpMethod} ${dArr.length} resource(s) to ${url} successful. StatusCode: ${response.statusCode}`);
        return response;
      } else {
        log.error(`${httpMethod} ${dArr.length} resource(s) to ${url} failed. StatusCode: ${response.statusCode}`);
        return response;
      }
    }).catch(err => {
      log.error(err);
      return err;
    });
  }
};
