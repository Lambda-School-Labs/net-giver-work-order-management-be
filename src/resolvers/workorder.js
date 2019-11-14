import Sequelize from "sequelize";
import { combineResolvers } from "graphql-resolvers";
import pubsub, { EVENTS } from "../subscription";
import { isAuthenticated, isWorkorderOwner } from "./authorization";
import {
  AuthenticationError,
  UserInputError,
  ApolloError
} from "apollo-server";
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.API_KEY,
  api_secret: process.env.API_SECRET
});

const toCursorHash = string => Buffer.from(string).toString("base64");

const fromCursorHash = string =>
  Buffer.from(string, "base64").toString("ascii");

export default {
  Query: {
    workorders: async (parent, { cursor, limit = 100 }, { models }) => {
      const cursorOptions = cursor
        ? {
            where: {
              createdAt: {
                [Sequelize.Op.lt]: fromCursorHash(cursor)
              }
            }
          }
        : {};

      const workorders = await models.Workorder.findAll({
        order: [["createdAt", "DESC"]],
        limit: limit + 1,
        ...cursorOptions
      });

      const hasNextPage = workorders.length > limit;
      const edges = hasNextPage ? workorders.slice(0, -1) : workorders;
      // const workordercount = workorders.length;

      return {
        edges,
        pageInfo: {
          workordercount: 50,
          hasNextPage,
          endCursor: toCursorHash(edges[edges.length - 1].createdAt.toString())
        }
      };
    },
    workorder: async (parent, { qrcode, id }, { models }) => {
      let workorder;
      try {
        if (!qrcode) {
          workorder = await models.Workorder.findByPk(id);
        } else {
          workorder = await models.Workorder.findOne({
            where: { qrcode: qrcode }
          });
        }
      } catch (error) {
        console.log(error);
        workorder = error;
      }
      return workorder;
    },
    comments: async (parent, { workorderId }, { models }) => {
      return await models.Comment.findAll({
        where: { workorderId: workorderId }
      });
    }
  },

  Mutation: {
    createWorkorder: combineResolvers(
      isAuthenticated,
      async (parent, { qrcode }, { models, user }) => {
        const workorder = await models.Workorder.create({
          qrcode,
          userId: user.id
        });

        pubsub.publish(EVENTS.WORKORDER.CREATED, {
          workorderCreated: { workorder }
        });

        return workorder;
      }
    ),

    editWorkorder: combineResolvers(
      isAuthenticated,
      async (
        parent,
        { id, qrcode, detail, priority, status, title },
        { models, user }
      ) => {
        // const workorder = await models.Workorder.findOne({ where: { qrcode } });
        const workorder = await models.Workorder.findByPk(id);
        const editedworkorder = await workorder.update({
          qrcode,
          detail,
          priority,
          status,
          title
        });
        return editedworkorder;
      }
    ),

    deleteWorkorder: combineResolvers(
      isAuthenticated,
      isWorkorderOwner,
      async (parent, { id }, { models }) => {
        return await models.Workorder.destroy({ where: { id } });
      }
    ),
    addComment: combineResolvers(
      isAuthenticated,
      async (parent, { comment }, { models, user }) => {
        const { text, workorderId, photo } = comment;

        const woExists = await models.Workorder.findByPk(workorderId, {
          select: ["id"]
        });
        if (!woExists) {
          throw new ApolloError("Workorder ID doesnt exist .");
        }
        let url;
        if (photo) {
          const { filename, createReadStream } = await photo;

          try {
            const result = await new Promise((resolve, reject) => {
              createReadStream().pipe(
                cloudinary.uploader.upload_stream(
                  {
                    use_filename: true
                  },
                  (error, result) => {
                    if (error) {
                      reject(error);
                    }
                    resolve(result);
                  }
                )
              );
            });
            url = result.secure_url;
          } catch (err) {
            throw new ApolloError(err.message);
          }
        }
        try {
          const newComment = await models.Comment.create({
            text,
            workorderId: workorderId,
            userId: user.id,
            image: url
          });
          return newComment;
        } catch (err) {
          throw new ApolloError(err.message);
        }
      }
    ),
    deleteComment: combineResolvers(
      isAuthenticated,
      async (parent, { id }, { models, user }) => {
        const commentExists = await models.Comment.findByPk(id, {
          select: ["id"]
        });
        if (!commentExists) {
          throw new ApolloError("Comment doesnt exist.");
        }
        try {
          return await models.Comment.destroy({ where: { id } });
        } catch (err) {
          throw new ApolloError(err.message);
        }
      }
    )
  },

  Workorder: {
    // user: async (workorder, args, { loaders }) => {
    //   return await loaders.user.load(workorder.userId);
    // }
    user: async (workorder, args, { models }) => {
      return await models.User.findOne({ where: { id: workorder.userId } });
    },

    workorderphotos: async (workorder, args, { models }) => {
      return await models.Workorderphoto.findAll({
        where: { workorderId: workorder.id },
        order: [
          // Will escape title and validate DESC against a list of valid direction parameters
          ["photocount", "DESC"]
        ],
        limit: 3
      });
    },
    workorderphoto: async (workorder, args, { models }) => {
      return await models.Workorderphoto.findOne({
        where: { workorderId: workorder.id },
        order: [
          // Will escape title and validate DESC against a list of valid direction parameters
          ["photocount", "DESC"]
        ]
      });
    },
    comments: async (workorder, args, { models }) => {
      return await models.Comment.findAll({
        where: { workorderId: workorder.id }
      });
    }
  },
  Comment: {
    user: async (comment, args, { models }) => {
      return await models.User.findOne({ where: { id: comment.userId } });
    }
  },

  Subscription: {
    workorderCreated: {
      subscribe: () => pubsub.asyncIterator(EVENTS.WORKORDER.CREATED)
    }
  }
};
