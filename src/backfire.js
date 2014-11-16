/*!
 * BackFire is the officially supported Backbone binding for Firebase. The
 * bindings let you use special model and collection types that allow for
 * synchronizing data with Firebase.
 *
 * BackFire 0.0.0
 * https://github.com/firebase/backfire/
 * License: MIT
 */

(function(_, Backbone) {
  "use strict";

  Backbone.Firebase = {
    _determineAutoSync: function(self, options) {
      var proto = Object.getPrototypeOf(self);
      return _.extend(
        {
          autoSync: proto.hasOwnProperty('autoSync') ? proto.autoSync : true
        },
        this,
        options
      ).autoSync;
    }
  };

  // Syncing for once only
  Backbone.Firebase.sync = function(method, model, options) {
    var modelJSON = model.toJSON();

    if (method === 'read') {

      Backbone.Firebase._readOnce(model.firebase, function onComplete(snap) {
        var resp = snap.val();
        options.success(resp);
      });

    } else if (method === 'create') {

      Backbone.Firebase._setWithCheck(model.firebase, modelJSON, options);

    } else if (method === 'update') {

      Backbone.Firebase._updateWithCheck(model.firebase, modelJSON, options);

    } else if(method === 'delete') {

      Backbone.Firebase._setWithCheck(model.firebase, null, options);

    }

  };

  Backbone.Firebase._readOnce = function(ref, cb) {
    ref.once('value', cb);
  };

  Backbone.Firebase._setToFirebase = function(ref, item, onComplete) {
    ref.set(item, onComplete);
  };

  Backbone.Firebase._updateToFirebase = function(ref, item, onComplete) {
    ref.update(item, onComplete);
  };

  Backbone.Firebase._onCompleteCheck = function(err, item, options) {
    if(!options) { return; }

    if(err && options.error) {
      options.error(item, err, options);
    } else if(options.success) {
      options.success(item, null, options);
    }
  };

  Backbone.Firebase._setWithCheck = function(ref, item, options) {
    Backbone.Firebase._setToFirebase(ref, item, function(err) {
      Backbone.Firebase._onCompleteCheck(err, item, options);
    });
  };

  Backbone.Firebase._updateWithCheck = function(ref, item, options) {
    Backbone.Firebase._updateToFirebase(ref, item, function(err) {
      Backbone.Firebase._onCompleteCheck(err, item, options);
    });
  };

  Backbone.Firebase._throwError = function(message) {
    throw new Error(message);
  };

  // string - return new Firebase
  // object - assume ref and return
  Backbone.Firebase._determineRef = function(objOrString) {
    switch (typeof(objOrString)) {
    case 'string':
      return new Firebase(objOrString);
    case 'object':
      return objOrString;
    default:
      Backbone.Firebase._throwError('Invalid type passed to url property');
    }
  };

  // if the model does not have an id check to make
  // sure it's an object and assign the id to the
  // name of the snapshot
  Backbone.Firebase._checkId = function(snap) {
    var model = snap.val();

    // if the model is a primitive throw an error
    if (Backbone.Firebase._isPrimitive(model)) {
      Backbone.Firebase._throwError('InvalidIdException: Models must have an Id. Note: You may ' +
      'be trying to sync a primitive value (int, string, bool).');
    }

    // if the model is null set it to an empty object and assign its id
    // this way listeners can still be attached to populate the object in the future
    if(model === null) {
      model = {};
    }

    // set the id to the snapshot's key
    model.id = snap.name();

    return model;
  };

  Backbone.Firebase._isPrimitive = function(model) {
    // is the model not an object and not null (basically, is it a primitive?)
    return !_.isObject(model) && model !== null;
  };

  // Model responsible for autoSynced objects
  // This model is never directly used. The Backbone.Firebase.Model will
  // inherit from this if it is an autoSynced model
  var SyncModel = (function() {

    function SyncModel() {
      // Set up sync events

      // apply remote changes locally
      this.firebase.on('value', function(snap) {

        this._setLocal(snap);
        this.trigger('sync', this, null, null);
      }, this);

      // apply local changes remotely
      this._listenLocalChange(function(model) {
        this.firebase.update(model);
      });

    }

    SyncModel.protoype = {
      save: function() {
        console.warn('Save called on a Firebase model with autoSync enabled, ignoring.');
      },
      fetch: function() {
        console.warn('Save called on a Firebase model with autoSync enabled, ignoring.');
      },
      sync: function(method, model, options) {
        if(method === 'delete') {
          Backbone.Firebase.sync(method, model, options);
        } else {
          console.warn('Sync called on a Fireabse model with autoSync enabled, ignoring.');
        }
      }
    };

    return SyncModel;
  }());

  // Model responsible for one-time requests
  // This model is never directly used. The Backbone.Firebase.Model will
  // inherit from this if it is not an autoSynced model
  var OnceModel = (function() {

    function OnceModel() {

      // when an unset occurs set the key to null
      // so Firebase knows to delete it on the server
      this._listenLocalChange(function(model) {
        this.set(model, { silent: true });
      });

    }

    OnceModel.protoype = {

      sync: function(method, model, options) {
        Backbone.Firebase.sync(method, model, options);
      }

    };

    return OnceModel;
  }());

  Backbone.Firebase.Model = Backbone.Model.extend({

    // Determine whether the realtime or once methods apply
    constructor: function(model, options) {
      Backbone.Model.apply(this, arguments);
      var defaults = _.result(this, 'defaults');

      this.backboneDestroy = this.destroy;

      // Apply defaults only after first sync.
      this.once('sync', function() {
        this.set(_.defaults(this.toJSON(), defaults));
      });

      this.autoSync = Backbone.Firebase._determineAutoSync(this, options);

      switch (typeof this.url) {
      case 'string':
        this.firebase = Backbone.Firebase._determineRef(this.url);
        break;
      case 'function':
        this.firebase = Backbone.Firebase._determineRef(this.url());
        break;
      case 'object':
        this.firebase = Backbone.Firebase._determineRef(this.url);
        break;
      default:
        Backbone.Firebase._throwError('url parameter required');
      }

      if(!this.autoSync) {
        OnceModel.apply(this, arguments);
        _.extend(this, OnceModel.protoype);
      } else {
        _.extend(this, SyncModel.protoype);
        SyncModel.apply(this, arguments);
      }

    },

    // siliently set the id of the model to the snapshot name
    _setId: function(snap) {
      // if the item new set the name to the id
      if(this.isNew()) {
        this.set('id', snap.name(), { silent: true });
      }
    },

    // proccess changes from a snapshot and apply locally
    _setLocal: function(snap) {
      var newModel = this._unsetAttributes(snap);
      this.set(newModel);
    },

    // Unset attributes that have been deleted from the server
    // by comparing the keys that have been removed.
    _unsetAttributes: function(snap) {
      var newModel = Backbone.Firebase._checkId(snap);

      if (typeof newModel === 'object' && newModel !== null) {
        var diff = _.difference(_.keys(this.attributes), _.keys(newModel));
        _.each(diff, _.bind(function(key) {
          this.unset(key);
        }, this));
      }

      // check to see if it needs an id
      this._setId(snap);

      return newModel;
    },

    // Find the deleted keys and set their values to null
    // so Firebase properly deletes them.
    _updateModel: function(model) {
      var modelObj = model.changedAttributes();
      _.each(model.changed, function(value, key) {
        if (typeof value === "undefined" || value === null) {
          if (key == "id") {
            delete modelObj[key];
          } else {
            modelObj[key] = null;
          }
        }
      });

      return modelObj;
    },

    // determine if we will update the model for every change
    _listenLocalChange: function(cb) {
      var method = cb ? 'on' : 'off';
      this[method]('change', function(model) {
        var newModel = this._updateModel(model);
        if(_.isFunction(cb)){
          cb.call(this, newModel);
        }
      }, this);
    }

  });

  var OnceCollection = (function() {
    function OnceCollection() {

    }
    OnceCollection.protoype = {
      // Create an id from a Firebase push-id and call Backbone.create, which
      // will do prepare the models and trigger the proper events and then call
      // Backbone.Firebase.sync with the correct method.
      create: function(model, options) {
        model.id = this.firebase.push().name();
        options = _.extend({ autoSync: false }, options);
        return Backbone.Collection.prototype.create.apply(this, [model, options]);
      },
      // Create an id from a Firebase push-id and call Backbone.add, which
      // will do prepare the models and trigger the proper events and then call
      // Backbone.Firebase.sync with the correct method.
      add: function(model, options) {
        model.id = this.firebase.push().name();
        options = _.extend({ autoSync: false }, options);
        return Backbone.Collection.prototype.add.apply(this, [model, options]);
      },
      // Proxy to Backbone.Firebase.sync
      sync: function(method, model, options) {
        Backbone.Firebase.sync(method, model, options);
      },
      // Firebase returns lists as an object with keys, where Backbone
      // collections require an array. This function modifies the existing
      // Backbone.Collection.fetch method by mapping the returned object from
      // Firebase to an array that Backbone can use.
      fetch: function(options) {
        options = options ? _.clone(options) : {};
        if (options.parse === void 0) { options.parse = true; }
        var success = options.success;
        var collection = this;
        options.success = function(resp) {
          var arr = [];
          var keys = _.keys(resp);
          _.each(keys, function(key) {
            arr.push(resp[key]);
          });
          var method = options.reset ? 'reset' : 'set';
          collection[method](arr, options);
          if (success) { success(collection, arr, options); }
          options.autoSync = false;
          options.url = this.url;
          collection.trigger('sync', collection, arr, options);
        };
        return this.sync('read', this, options);
      }
    };

    return OnceCollection;
  }());

  var SyncCollection = (function() {

    function SyncCollection() {
      // Add handlers for remote events
      this.firebase.on("child_added", _.bind(this._childAdded, this));
      this.firebase.on("child_moved", _.bind(this._childMoved, this));
      this.firebase.on("child_changed", _.bind(this._childChanged, this));
      this.firebase.on("child_removed", _.bind(this._childRemoved, this));

      // Once handler to emit "sync" event.
      this.firebase.once("value", _.bind(function() {
        this.trigger("sync", this, null, null);
      }, this));

      // Handle changes in any local models.
      this.listenTo(this, "change", this._updateModel, this);
      // Listen for destroy event to remove models.
      this.listenTo(this, "destroy", this._removeModel, this);
    }

    SyncCollection.protoype = {
      comparator: function(model) {
        return model.id;
      },

      add: function(models, options) {
        var parsed = this._parseModels(models);
        options = options ? _.clone(options) : {};
        options.success =
          _.isFunction(options.success) ? options.success : function() {};

        var success = options.success;
        options.success = _.bind(function(model, resp) {
          if (success) {
            success(model, resp, options);
          }
          this.trigger('sync', this, null, null);
        }, this);

        for (var i = 0; i < parsed.length; i++) {
          var model = parsed[i];

          if (options.silent === true) {
            this._suppressEvent = true;
          }

          var childRef = this.firebase.ref().child(model.id);
          childRef.set(model, _.bind(options.success, model));
        }

        return parsed;
      },

      create: function(model, options) {
        options = options ? _.clone(options) : {};
        if (options.wait) {
          this._log("Wait option provided to create, ignoring.");
        }
        if (!model) {
          return false;
        }
        var set = this.add([model], options);
        return set[0];
      },

      remove: function(models, options) {
        var parsed = this._parseModels(models);
        options = options ? _.clone(options) : {};
        options.success =
          _.isFunction(options.success) ? options.success : function() {};

        for (var i = 0; i < parsed.length; i++) {
          var model = parsed[i];
          var childRef = this.firebase.child(model.id);
          if (options.silent === true) {
            this._suppressEvent = true;
          }
          Backbone.Firebase._setWithCheck(childRef, null, options);
        }

        return parsed;
      },

      reset: function(models, options) {
        options = options ? _.clone(options) : {};
        // Remove all models remotely.
        this.remove(this.models, {silent: true});
        // Add new models.
        var ret = this.add(models, {silent: true});
        // Trigger "reset" event.
        if (!options.silent) {
          this.trigger('reset', this, options);
        }
        return ret;
      },

      _log: function(msg) {
        if (console && console.log) {
          console.log(msg);
        }
      },

      _parseModels: function(models, options) {
        var pushArray = [];
        // check if the models paramter is an array or a single object
        var singular = !_.isArray(models);
        // if the models parameter is a single object then wrap it into an array
        models = singular ? (models ? [models] : []) : models.slice();

        for (var i = 0; i < models.length; i++) {
          var model = models[i];

          if (!model.id) {
            model.id = this.firebase.push().name();
          }

          // call Backbone's prepareModel to apply options
          model = Backbone.Collection.prototype._prepareModel.apply(
            this, [model, options || {}]
          );

          if (model.toJSON && typeof model.toJSON == "function") {
            model = model.toJSON();
          }

          pushArray.push(model);

        }
        return pushArray;
      },

      _childAdded: function(snap) {
        var model = Backbone.Firebase._checkId(snap);

        if (this._suppressEvent === true) {
          this._suppressEvent = false;
          Backbone.Collection.prototype.add.apply(this, [model], {silent: true});
        } else {
          Backbone.Collection.prototype.add.apply(this, [model]);
        }
        this.get(model.id)._remoteAttributes = model;
      },

      _childMoved: function(snap) {
        // TODO: Investigate: can this occur without the ID changing?
        this._log("_childMoved called with " + snap.val());
      },

      // when a model has changed remotely find differences between the
      // local and remote data and apply them to the local model
      _childChanged: function(snap) {
        var model = Backbone.Firebase._checkId(snap);

        var item = _.find(this.models, function(child) {
          return child.id == model.id;
        });

        if (!item) {
          // TODO: Investigate: what is the right way to handle this case?
          //throw new Error("Could not find model with ID " + model.id);
          this._childAdded(snap);
          return;
        }

        this._preventSync(item, true);
        item._remoteAttributes = model;

        // find the attributes that have been deleted remotely and
        // unset them locally
        var diff = _.difference(_.keys(item.attributes), _.keys(model));
        _.each(diff, function(key) {
          item.unset(key);
        });

        item.set(model);
        this._preventSync(item, false);
      },

      // remove an item from the collection when removed remotely
      // provides the ability to remove siliently
      _childRemoved: function(snap) {
        var model = Backbone.Firebase._checkId(snap);

        if (this._suppressEvent === true) {
          this._suppressEvent = false;
          Backbone.Collection.prototype.remove.apply(
            this, [model], {silent: true}
          );
        } else {
          Backbone.Collection.prototype.remove.apply(this, [model]);
        }
      },

      // Add handlers for all models in this collection, and any future ones
      // that may be added.
      _updateModel: function(model) {
        var remoteAttributes;
        var localAttributes;
        var updateAttributes;
        var ref;

        // if the model is already being handled by listeners then return
        if (model._remoteChanging) {
          return;
        }

        remoteAttributes = model._remoteAttributes || {};
        localAttributes = model.toJSON();

        // consolidate the updates to Firebase
        updateAttributes = this._compareAttributes(remoteAttributes, localAttributes);

        ref = this.firebase.child(model.id);

        // if ".priority" is present setWithPriority
        // else do a regular update
        if (_.has(updateAttributes, ".priority")) {
          this._setWithPriority(ref, localAttributes);
        } else {
          this._updateToFirebase(ref, localAttributes);
        }

      },

      // set the attributes to be updated to Firebase
      // set any removed attributes to null so that Firebase removes them
      _compareAttributes: function(remoteAttributes, localAttributes) {
        var updateAttributes = {};

        var union = _.union(_.keys(remoteAttributes), _.keys(localAttributes));

        _.each(union, function(key) {
          if (!_.has(localAttributes, key)) {
            updateAttributes[key] = null;
          } else if (localAttributes[key] != remoteAttributes[key]) {
            updateAttributes[key] = localAttributes[key];
          }
        });

        return updateAttributes;
      },

      // Special case if ".priority" was updated - a merge is not
      // allowed so we'll have to do a full setWithPriority.
      _setWithPriority: function(ref, item) {
        var priority = item[".priority"];
        delete item[".priority"];
        ref.setWithPriority(item, priority);
        return item;
      },

      // TODO: possibly pass in options for onComplete callback
      _updateToFirebase: function(ref, item) {
        ref.update(item);
      },

      // Triggered when model.destroy() is called on one of the children.
      _removeModel: function(model, collection, options) {
        options = options ? _.clone(options) : {};
        options.success =
          _.isFunction(options.success) ? options.success : function() {};
        var childRef = this.firebase.child(model.id);
        Backbone.Firebase._setWithCheck(childRef, null, _.bind(options.success, model));
      },

      _preventSync: function(model, state) {
        model._remoteChanging = state;
      }
    };

    return SyncCollection;
  }());

  Backbone.Firebase.Collection = Backbone.Collection.extend({

    constructor: function (model, options) {
      Backbone.Collection.apply(this, arguments);
      var self = this;
      var BaseModel = self.model;
      this.autoSync = Backbone.Firebase._determineAutoSync(this, options);

      switch (typeof this.url) {
      case 'string':
        this.firebase = Backbone.Firebase._determineRef(this.url);
        break;
      case 'function':
        this.firebase = Backbone.Firebase._determineRef(this.url());
        break;
      case 'object':
        this.firebase = Backbone.Firebase._determineRef(this.url);
        break;
      default:
        throw new Error('url parameter required');
      }

      // if we are not autoSyncing, the model needs
      // to be a non-autoSynced model
      if(!this.autoSync) {
        _.extend(this, OnceCollection.protoype);
        OnceCollection.apply(this, arguments);
      } else {
        _.extend(this, SyncCollection.protoype);
        SyncCollection.apply(this, arguments);
      }

      // Intercept the given model and give it a firebase ref.
      // Have it listen to local changes silently. When attributes
      // are unset, the callback will set them to null so that they
      // are removed on the Firebase server.
      this.model = function(attrs, opts) {

        var newItem = new BaseModel(attrs, opts);
        newItem.autoSync = false;
        newItem.firebase = self.firebase.child(newItem.id);
        newItem.sync = Backbone.Firebase.sync;
        newItem.on('change', function(model) {
          var updated = Backbone.Firebase.Model.prototype._updateModel(model);
          model.set(updated, { silent: true });
        });

        return newItem;

      };

    }

  });

})(window._, window.Backbone);